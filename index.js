// 心相引擎 · 独立判定（Heart Engine · Standalone Verdict）v1.2.0
//
// 把原「心相引擎」世界书方案中"靠主API在 <thinking> 里自掷骰、自算阈值、自复制快照"
// 的判定方式，剥离为一个独立流程：
//   1) 插件用 crypto 真随机掷骰（可 N 次取均值），主/副API都只能"原样引用"；
//   2) 每回合用一次独立的副API调用做推演（可配独立连接/独立模型）；
//   3) 阈值与区段由插件本地公式机械复核，增益自动钳制 + 理由禁复用；
//   4) 性格存档（轴/档序/铺垫/心结/心锚/临时状态/素材池）保存在聊天元数据；
//   5) 读取柏宝书公开API获取剧情记忆/状态/NPC好感；未安装时降级本地楼层；
//   6) 语义层治理：潜台词解读、被动铺垫、临时状态、惯性微扰动、岔路口漏检告警；
//   7) 浮动控制台（悬浮球+多标签面板）：角色档案（可编辑）/判定记录/核心旋钮。
//
// 主API每回合收到的只是一段"已结算的判定注入"——它只负责写正文。

// 注意：第三方扩展位于 /scripts/extensions/third-party/<name>/，
// 相对路径需三层/四层向上才能命中 /scripts/extensions.js 与 /script.js；
// saveMetadataDebounced 由 extensions.js 导出（script.js 不导出它）
import { getContext, extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
} from '../../../../script.js';

// ---------- 常量 ----------

const LOG = '[心相引擎]';
const INJECT_KEY = 'heart_engine_verdict';
const INJECT_DEPTH = 4;
const SUB_TIMEOUT_MS = 90 * 1000;
const RESPONSE_LENGTH = 1500;

// 区段 → 落子
const SEGMENT_MOVE = {
    '应激崩溃': '不做',
    '不做': '不做',
    '其它': '其它',
    '险胜': '做',
    '坚定': '做',
    '本能': '做',
};

// 区段 → 行为裁决文案（注入给主API）
const SEGMENT_RULING = {
    '应激崩溃': '强制"不做"——这是应激创伤反应，不是铺垫：心结加深，写失控崩溃的狼狈',
    '不做': '"不做"——挣扎而不得（腿在抖、喊不出来、迈不动步），这次失败成为下一次的砝码',
    '其它': '"其它"（第三条路）——既不冲上去也不逃走：{thirdWay}。必须绕开"做"的核心代价，只拿部分或延迟的结果，她心里知道自己绕了',
    '险胜': '"做"（险胜）——成是成了，但写足侥幸、狼狈、事后自己都后怕，惯性几乎压过去',
    '坚定': '"做"（坚定）——仍须写"惯性仍在、被压过去"，禁止云淡风轻（档序已由系统+1）',
    '本能': '"做"（本能强制）——身体先于大脑，事后她自己都会愣住',
};

// 判定输出的 JSON Schema：受支持的API可从底层强制返回合法JSON
const VERDICT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        noCrossroad: { type: 'boolean' },
        subtext: { type: 'string' },
        characters: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    isNew: { type: 'boolean' },
                    axis: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            tiers: { type: 'array', items: { type: 'string' } },
                            tierNow: { type: 'integer' },
                        },
                    },
                    anchor: { type: 'string' },
                    crossroad: { type: 'object', properties: { do: { type: 'string' }, not: { type: 'string' } } },
                    relState: { type: 'string' },
                    emoState: { type: 'string' },
                    gains: { type: 'array', items: { type: 'object', properties: { value: { type: 'integer' }, reason: { type: 'string' } } } },
                    brakes: { type: 'array', items: { type: 'object', properties: { value: { type: 'integer' }, reason: { type: 'string' } } } },
                    threshold: { type: 'integer' },
                    segment: { type: 'string' },
                    thirdWay: { type: 'string' },
                    forceNot: { type: 'string' },
                    forceDo: { type: 'string' },
                    memory: { type: 'string' },
                    ding: { type: 'string' },
                    afterglow: { type: 'string' },
                    blockNote: { type: 'string' },
                },
                required: ['name'],
            },
        },
        passiveForeshadow: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } } } },
        tempState: { type: 'object', properties: { name: { type: 'string' }, tag: { type: 'string' }, note: { type: 'string' }, floors: { type: 'integer' } } },
        microDeviation: { type: 'object', properties: { name: { type: 'string' }, action: { type: 'string' } } },
        world: { type: 'string' },
    },
    required: ['noCrossroad', 'characters'],
};

// ---------- 世界书联动（聊天绑定：每个聊天一本专属书） ----------

let worldInfoModule = null;   // 缓存；false=不可用
let cachedProfileTemplates = {}; // {角色名: {axis:{name,tiers}, anchor}} — 每回合从聊天绑定的世界书刷新

async function getWorldInfoModule() {
    if (worldInfoModule !== null) return worldInfoModule;
    try {
        worldInfoModule = await import('../../../world-info.js');
    } catch (e) {
        console.warn(LOG, 'world-info 模块加载失败，世界书联动停用', e);
        worldInfoModule = false;
    }
    return worldInfoModule;
}

// 本聊天专属书的名字：由聊天ID生成，绑定关系存在聊天元数据（store.wiBookName）
async function ensureChatBook() {
    const store = getStore();
    if (store.wiBookName) return store.wiBookName;
    const wi = await getWorldInfoModule();
    if (!wi) return '';
    const context = getContext();
    const chatId = String(context.chatId || context.characterId || 'chat');
    const name = `心相引擎·${chatId}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90);

    let book = await wi.loadWorldInfo(name).catch(() => null);
    if (!book?.entries) {
        book = { entries: {} };
        await wi.saveWorldInfo(name, book, true);
        try { await wi.updateWorldInfoList?.(); } catch { /* 列表刷新失败不影响 */ }
    }
    store.wiBookName = name;
    saveMetadataDebounced();

    // 激活：把书加进本聊天的世界书绑定（保留用户已手动绑定的其它书）
    try {
        const current = wi.getChatWorldInfoNames();
        if (!current.includes(name)) {
            wi.setChatWorldInfoSelection([...current, name]);
            saveMetadataDebounced();
            console.info(LOG, `已将《${name}》绑定到当前聊天`);
        }
    } catch (e) {
        console.warn(LOG, '自动绑定聊天世界书失败（可在世界书面板手动勾选）', e);
    }
    return name;
}

// 读取「心相·建档·角色名」条目作为预设建档模板（扫描本聊天绑定的所有世界书）
function parseProfileTemplate(content) {
    const text = String(content || '');
    const axisLine = text.match(/轴[:：]\s*(.+)/);
    const tiersLine = text.match(/档位[:：]\s*(.+)/);
    const anchorLine = text.match(/心锚[:：]\s*(.+)/);
    if (!axisLine && !tiersLine) return null;
    const tiers = tiersLine ? tiersLine[1].split(/[|｜]/).map(s => s.trim()).filter(Boolean).slice(0, 4) : [];
    if (tiers.length < 2) tiers.push('动摇', '跨线');
    let anchor = anchorLine ? anchorLine[1].trim() : '';
    const quoted = anchor.match(/^["“](.*)["”]$/);
    if (quoted) anchor = quoted[1];
    return { axis: { name: (axisLine ? axisLine[1].trim() : '性格轴').slice(0, 12), tiers }, anchor: anchor.slice(0, 60) };
}

async function fetchProfileTemplates() {
    cachedProfileTemplates = {};
    try {
        const wi = await getWorldInfoModule();
        if (!wi) return cachedProfileTemplates;
        const bookNames = new Set(wi.getChatWorldInfoNames());
        const own = getStore().wiBookName;
        if (own) bookNames.add(own);
        for (const bookName of bookNames) {
            const book = await wi.loadWorldInfo(bookName).catch(() => null);
            if (!book?.entries) continue;
            for (const entry of Object.values(book.entries)) {
                if (entry?.disable) continue;
                const comment = String(entry?.comment || '');
                if (!comment.startsWith('心相·建档·')) continue;
                const name = comment.slice('心相·建档·'.length).trim();
                const profile = parseProfileTemplate(entry.content);
                if (name && profile) cachedProfileTemplates[name] = profile;
            }
        }
    } catch (e) {
        console.warn(LOG, '读取世界书预设建档失败', e);
    }
    return cachedProfileTemplates;
}

// 把角色当前档案与近期经历写入本聊天专属书（条目键=角色名，角色在场时自动注入）
function buildExperienceContent(name, ch) {
    const ax = ch.axes?.[0] || {};
    const tierName = ax.tiers?.[(ax.tier || 1) - 1] || '?';
    const lines = [];
    lines.push(`【心相引擎·角色档案】${name}`);
    lines.push(`${ax.name || '性格轴'}:当前处于「${tierName}」(档序${ax.tier || 1})｜铺垫:${ch.foreshadow || 0}｜心结:${ch.block || '—'}${ch.temp ? `｜当前状态:${ch.temp.tag}` : ''}`);
    if (ch.anchor) lines.push(`心锚:"${ch.anchor}"`);
    lines.push('【她的经历】');
    const hist = (ch.history || []).slice(0, 8);
    if (!hist.length) lines.push('（尚无记录）');
    for (const h of hist) {
        const d = new Date(h.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        lines.push(`- ${d} #${h.mesid}:面临「${h.crossroad || '（未记录）'}」→ ${h.move}(${h.segment})${h.ding ? `。定音:${h.ding}` : ''}`);
    }
    return lines.join('\n');
}

async function syncExperienceEntries(names) {
    const wi = await getWorldInfoModule();
    if (!wi) return;
    const bookName = await ensureChatBook();
    if (!bookName) return;
    const store = getStore();
    let book = await wi.loadWorldInfo(bookName).catch(() => null);
    if (!book?.entries) book = { entries: {} };
    let changed = false;
    for (const name of names) {
        const ch = store.characters[name];
        if (!ch) continue;
        const comment = `心相·经历·${name}`;
        let entry = Object.values(book.entries).find(e => String(e?.comment || '') === comment);
        if (!entry) {
            entry = wi.createWorldInfoEntry(bookName, book);
            if (!entry) continue;
            entry.comment = comment;
            entry.key = [name];
            entry.constant = false;
            entry.selective = true;
            entry.order = 100;
            entry.position = wi.world_info_position?.after ?? 1;
            entry.preventRecursion = true;
            changed = true;
        }
        const content = buildExperienceContent(name, ch);
        if (entry.content !== content) { entry.content = content; changed = true; }
        if (JSON.stringify(entry.key) !== JSON.stringify([name])) { entry.key = [name]; changed = true; }
    }
    if (!changed) return;
    await wi.saveWorldInfo(bookName, book, true);
    console.info(LOG, `世界书《${bookName}》已更新（${names.join('、')}）`);
}

// 聊天变量检取：按用户预设路径读取 chat_metadata.variables（MVU/酒馆助手变量树）
// 框架常把对象存成JSON字符串（如 NY-Sogon主程序），读取时透明解析
function tryParseJsonString(s) {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    if (!/^[\[{]/.test(t)) return s;
    try { return JSON.parse(t); } catch { return s; }
}

function readVarPath(root, path) {
    let cur = root;
    for (const seg of String(path || '').split('.')) {
        if (cur == null) return undefined;
        cur = tryParseJsonString(cur);
        if (cur == null || typeof cur !== 'object') return undefined;
        const m = seg.match(/^(.+?)\[(\d+)\]$/);
        if (m) {
            cur = cur[m[1]];
            cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
        } else {
            cur = cur[seg];
        }
    }
    return tryParseJsonString(cur);
}

function findPresenceNames(root) {
    for (const p of ['stat_data.世界状态.在场角色', '世界状态.在场角色', '在场角色']) {
        const v = readVarPath(root, p);
        if (Array.isArray(v) && v.length) return v.map(x => String(x));
    }
    return null;
}

function filterObjectByNames(val, names) {
    if (!names?.length || !val || typeof val !== 'object' || Array.isArray(val)) return null;
    const keys = Object.keys(val);
    const matched = keys.filter(k => names.some(n => k.includes(n) || n.includes(k)));
    if (!matched.length) return null;
    const out = {};
    for (const k of matched) out[k] = val[k];
    return out;
}

async function collectChatVariables() {
    try {
        const settings = getSettings();
        if (!settings.varPickup) return '';
        const context = getContext();
        const root = context.chatMetadata?.variables;
        if (!root || typeof root !== 'object') return '';
        const paths = String(settings.varPaths || '')
            .split(/[\n,，;；]+/)
            .map(x => x.trim())
            .filter(Boolean);
        // NY系列关系分析（独立开关与路径组）
        if (settings.nyVarOn) {
            for (const l of String(settings.nyPaths || '').split(/[\n,，;；]+/).map(x => x.trim()).filter(Boolean)) {
                if (!paths.includes(l)) paths.push(l);
            }
        }
        if (!paths.length) return '';
        const presenceNames = findPresenceNames(root);
        const budget = Math.max(200, Math.min(20000, Number(settings.varMaxChars) || 2000));
        const sections = [];
        let total = 0;
        for (const p of paths) {
            let val = readVarPath(root, p);
            if (val === undefined || val === null) continue;
            // 按名字组织的分支（如角色社交）优先只保留在场者
            const filtered = filterObjectByNames(val, presenceNames);
            if (filtered) val = filtered;
            let text;
            if (typeof val === 'string') {
                text = val.trim();
            } else {
                try { text = JSON.stringify(val); } catch { continue; }
            }
            if (!text || text === '{}' || text === '[]') continue;
            const remain = budget - total;
            if (remain <= 100) break;
            text = text.slice(0, Math.max(300, remain));
            sections.push(`【${p}】\n${text}`);
            total += text.length + 2;
        }
        if (!sections.length) return '';
        console.info(LOG, `聊天变量检取:${sections.length}段（${total}字）`);
        return sections.join('\n\n');
    } catch (e) {
        console.warn(LOG, '聊天变量检取失败', e);
        return '';
    }
}

// 角色卡世界书检取：关键词触发的设定条目，喂给副API判定卷子（恒定条目恒定入选）
async function collectCardLore() {
    try {
        const settings = getSettings();
        if (!settings.cardLorePickup) return '';
        const wi = await getWorldInfoModule();
        if (!wi) return '';
        const context = getContext();
        const character = context.characterId != null ? context.characters?.[context.characterId] : null;
        const book = character?.data?.character_book;
        if (!book?.entries?.length) return '';

        // 扫描文本：最近3楼（含最新用户消息）
        const chat = context.chat || [];
        const scanParts = [];
        for (let i = Math.max(0, chat.length - 3); i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            scanParts.push(String(m.mes || ''));
        }
        const scanTextRaw = scanParts.join('\n');
        const scanText = scanTextRaw.toLowerCase();
        if (!scanText) return '';

        const converted = wi.convertCharacterBook(book);
        const budget = Math.max(500, Math.min(20000, Number(settings.loreMaxChars) || 3000));
        const picked = [];
        let total = 0;

        const entries = Object.values(converted.entries).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        for (const entry of entries) {
            if (entry.disable) continue;
            const content = String(entry.content || '').trim();
            if (!content) continue;
            const keys = (Array.isArray(entry.key) ? entry.key : []).map(k => String(k)).filter(Boolean);
            const isConstant = !!entry.constant;
            let hit = isConstant;
            if (!hit) {
                for (const k of keys) {
                    const needle = entry.caseSensitive ? k : k.toLowerCase();
                    const hay = entry.caseSensitive ? scanTextRaw : scanText;
                    if (!needle) continue;
                    if (entry.matchWholeWords && /^[\w\s-]+$/.test(needle)) {
                        if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, entry.caseSensitive ? '' : 'i').test(scanTextRaw)) { hit = true; break; }
                    } else if (hay.includes(needle)) { hit = true; break; }
                }
            }
            if (!hit) continue;
            const title = String(entry.comment || keys[0] || '设定').slice(0, 30);
            const block = `◆ ${title}\n${content}`;
            if (total + block.length > budget) continue;
            picked.push(block);
            total += block.length + 2;
        }
        if (!picked.length) return '';
        console.info(LOG, `角色卡世界书检取:${picked.length}条（${total}字）`);
        return picked.join('\n\n');
    } catch (e) {
        console.warn(LOG, '角色卡世界书检取失败', e);
        return '';
    }
}

// ---------- 设置 ----------

function ensureSettings() {
    const defaults = {
        enabled: true,          // 总开关
        autoMode: true,         // true=生成前自动判定；false=仅 /heart 手动
        baseThreshold: 80,      // 阈值公式基准
        tierPenalty: 10,        // 每档序的阈值降幅
        foreshadowPenalty: 10,  // 每点铺垫的阈值降幅
        diceSampleCount: 10,    // 每次判定的掷骰次数（取平均；1=传统单骰1d100）
        microDeviationChance: 5,// 惯性微扰动触发概率%（0=关闭；仅无岔路口回合判定）
        contextFloors: 3,       // 本地降级时读取的最近楼层原文数
        strictRetry: true,      // JSON解析失败/区段不一致时自动重试一次
        worldDice: true,        // 世界骰（与人无关的偶然）
        maxCharsPerFloor: 2,    // 每楼全量判定的角色上限（心相分析焦点制）
        useJsonSchema: true,    // 结构化输出（API不支持JSON Schema时关闭）
        subApiUrl: '',          // 独立副API地址（OpenAI兼容，如 https://api.example.com/v1；留空跟随主API）
        subApiKey: '',          // 独立副API密钥
        subApiModel: '',        // 独立副API模型名
        subTemperature: 0.7,    // 独立副API采样温度
        subResponseLength: 1500, // 副API输出上限（token）
        customPromptTemplate: '', // 自定义判定提示词模板（空=内置模板）
        extraInstructions: '',   // 附加指令（追加在模板末尾）
        showFloorBadge: true,    // 在楼层下方显示判定徽章（仅显示，不进正文与上下文）
        worldBookSync: true,     // 经历写入本聊天专属世界书（每聊天一本，自动创建并绑定）
        cardLorePickup: true,    // 判定时检取角色卡世界书（关键词触发），让判定核心知道世界规则
        loreMaxChars: 3000,      // 角色卡世界书检取的字符预算
        varPickup: true,         // 读取聊天变量（MVU/酒馆助手维护的 variables 树）
        varPaths: 'stat_data.世界状态\nstat_data.主角状态\nstat_data.角色社交', // 要读取的变量路径（换行或逗号分隔；值为JSON字符串时自动解析后按子路径取字段）
        varMaxChars: 3500,       // 聊天变量检取的字符预算
        nyVarOn: true,           // 读取NY系列关系分析变量（路径见nyPaths）
        nyPaths: 'NY-Sogon主程序.关系进展\nNY-Sogon主程序.状态贴片\nNY-Sigon主程序.summary',
        bbsSnapshotOn: true,     // 柏宝书·状态快照
        bbsHistoryOn: true,      // 柏宝书·剧情压缩历史
        bbsMemoryOn: true,       // 柏宝书·长期记忆（注入层）
        fabPos: null,            // 悬浮球位置
        panelPos: null,          // 控制台面板位置
    };
    extension_settings.heartEngine = Object.assign({}, defaults, extension_settings.heartEngine || {});
    // 迁移：老默认路径/预算的用户平滑升级；并把 varPaths 里的 NY 行拆分到独立的 nyPaths
    const OLD_VAR_PATHS = 'stat_data.世界状态\nstat_data.主角状态\nstat_data.角色社交';
    if (extension_settings.heartEngine.varPaths === OLD_VAR_PATHS) {
        extension_settings.heartEngine.varPaths = defaults.varPaths;
    }
    if (Number(extension_settings.heartEngine.varMaxChars) === 2000) {
        extension_settings.heartEngine.varMaxChars = defaults.varMaxChars;
    }
    if (!extension_settings.heartEngine.nySplitDone) {
        const s = extension_settings.heartEngine;
        const lines = String(s.varPaths || '').split('\n');
        const nyLines = lines.filter(l => l.trim().startsWith('NY-'));
        if (nyLines.length) {
            s.varPaths = lines.filter(l => !l.trim().startsWith('NY-')).join('\n');
            s.nyPaths = nyLines.join('\n');
        }
        s.nySplitDone = true;
    }
}

function getSettings() {
    return extension_settings.heartEngine;
}

// ---------- 心相存档（跟随聊天） ----------

function getStore() {
    const context = getContext();
    context.chatMetadata ??= {};
    context.chatMetadata.heartEngine ??= { version: 2, characters: {}, lastAccounts: null, log: [] };
    const store = context.chatMetadata.heartEngine;
    store.characters ??= {};
    store.log ??= [];
    store.accountsByMesid ??= {};      // 每楼判定账目（楼层徽章/回滚用）
    store.streakNoCrossroad ??= 0;     // 连续无岔路口楼数（漏检告警）
    store.streakWarned ??= false;
    return store;
}

function resetStore() {
    const context = getContext();
    context.chatMetadata.heartEngine = { version: 2, characters: {}, lastAccounts: null, log: [], accountsByMesid: {}, streakNoCrossroad: 0, streakWarned: false };
    saveMetadataDebounced();
    renderPanel();
    if ($('#heart_panel').length && !$('#heart_panel').hasClass('hidden')) renderConsole();
}

// 确保角色档案存在（不存在则建最小档案）
function ensureCharacter(store, name) {
    if (!name) return null;
    if (!store.characters[name]) {
        store.characters[name] = {
            axes: [{ name: '性格轴', tiers: ['惯性', '动摇', '跨线'], tier: 1 }],
            anchor: '',
            foreshadow: 0,
            lastMove: '—',
            lastDing: '—',
            block: '—',
            history: [],
            recentMaterial: [],
            recentGains: [],
            recentBrakes: [],
            temp: null,
        };
    }
    const ch = store.characters[name];
    ch.history ??= [];
    ch.recentMaterial ??= [];
    ch.recentGains ??= [];
    return ch;
}

// ---------- 骰子与算式（全部本地机械执行） ----------

// 无偏差 1d100
function roll100() {
    const limit = Math.floor(0x100000000 / 100) * 100;
    const buf = new Uint32Array(1);
    do {
        crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return (buf[0] % 100) + 1;
}

// 掷骰：N 次取平均（N=1 时为传统单骰）。次数越多分布越向中间收拢，极端区段越稀有
function rollDice(sampleCount) {
    const n = Math.max(1, Math.min(20, Number(sampleCount) || 1));
    if (n === 1) return roll100();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += roll100();
    return Math.round(sum / n);
}

// 增益理由规范化与重叠判断（治理增益通胀：同一理由只加一次砝码）
function normalizeReason(s) {
    return String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
}

function reasonOverlaps(a, b) {
    a = normalizeReason(a);
    b = normalizeReason(b);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const grain = Math.min(6, a.length, b.length);
    if (grain < 4) return false;
    for (let i = 0; i + grain <= a.length; i++) {
        if (b.includes(a.slice(i, i + grain))) return true;
    }
    return false;
}

// 增益钳制：≤2项、单项≤10、必须有现场依据、不得与近期理由重复
function clampGain(gains, recentReasons = []) {
    return (Array.isArray(gains) ? gains : [])
        .filter(g => g && (g.reason || '').toString().trim())
        .map(g => ({
            value: Math.max(0, Math.min(10, Number(g.value) || 0)),
            reason: String(g.reason).slice(0, 30),
        }))
        .filter(g => g.value > 0)
        .filter(g => !recentReasons.some(r => reasonOverlaps(r, g.reason)))
        .slice(0, 2);
}

function computeThreshold(settings, foreshadow, tier, gains, brakes = []) {
    const gainSum = gains.reduce((acc, g) => acc + g.value, 0);
    const brakeSum = brakes.reduce((acc, g) => acc + g.value, 0);
    const pForeshadow = Math.max(0, Number(settings.foreshadowPenalty ?? 10));
    const pTier = Math.max(0, Number(settings.tierPenalty ?? 10));
    const formula = settings.baseThreshold - foreshadow * pForeshadow - (tier - 1) * pTier - gainSum + brakeSum;
    let eq = `${settings.baseThreshold}−铺垫${foreshadow}×${pForeshadow}−(档序${tier}−1)×${pTier}−增益${gainSum}`;
    if (brakeSum > 0) eq += `+阻力${brakeSum}`;
    const formulaText = `${eq}＝${formula}`;
    const clamped = Math.max(20, Math.min(90, formula));
    return { formulaText, threshold: clamped, isClamped: formula !== clamped };
}

function normalizeAxis(raw) {
    const tiers = (Array.isArray(raw?.tiers) ? raw.tiers : [])
        .map(t => String(t).slice(0, 30))
        .filter(Boolean)
        .slice(0, 4);
    if (tiers.length < 2) tiers.push('动摇', '跨线');
    return {
        name: String(raw?.name || '性格轴').slice(0, 12),
        tiers,
        tier: 1,
    };
}

// ---------- 副API调用（独立连接优先，主API兜底） ----------

function getSubApiConfig() {
    const s = getSettings();
    return {
        url: String(s.subApiUrl || '').trim().replace(/\/+$/, ''),
        key: String(s.subApiKey || '').trim(),
        model: String(s.subApiModel || '').trim(),
        temperature: Math.max(0, Math.min(2, Number(s.subTemperature) || 0.7)),
        maxTokens: Math.max(200, Math.min(8000, Number(s.subResponseLength) || RESPONSE_LENGTH)),
    };
}

function extractChoiceContent(data) {
    const msg = data?.choices?.[0]?.message || {};
    // 思考类模型可能把内容放 reasoning_content，兜底取一下
    return String(msg.content || '').trim() || String(msg.reasoning_content || '').trim();
}

// 独立副API · 通道一：经酒馆服务器代理（同源无CORS，密钥经 custom_include_headers 透传）
async function callSubApiProxy(cfg, messages) {
    const baseUrl = cfg.url.replace(/\/chat\/completions\/?$/i, '');
    const customHeaders = {};
    if (cfg.key) customHeaders['Authorization'] = `Bearer ${cfg.key}`;
    const res = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: baseUrl,
            model: cfg.model,
            messages,
            max_tokens: cfg.maxTokens,
            temperature: cfg.temperature,
            stream: false,
            custom_include_headers: customHeaders,
        }),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`代理HTTP ${res.status}：${errText.slice(0, 150)}`);
    }
    const content = extractChoiceContent(await res.json());
    if (!content) throw new Error('代理返回为空');
    return content;
}

// 独立副API · 通道二：浏览器直连（代理失败时备选）
async function callSubApiDirect(cfg, messages) {
    const url = cfg.url.replace(/\/chat\/completions\/?$/i, '') + '/chat/completions';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(cfg.key ? { 'Authorization': `Bearer ${cfg.key}` } : {}),
        },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            max_tokens: cfg.maxTokens,
            temperature: cfg.temperature,
            stream: false,
        }),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`直连HTTP ${res.status}：${errText.slice(0, 150)}`);
    }
    const content = extractChoiceContent(await res.json());
    if (!content) throw new Error('直连返回为空');
    return content;
}

async function callSubApi(prompt) {
    const cfg = getSubApiConfig();
    const messages = [
        { role: 'system', content: '你是「心相引擎」的判定核心，只输出JSON，不输出任何其他内容。' },
        { role: 'user', content: prompt },
    ];

    // 优先：独立副API连接（面板填写了地址与模型即启用）
    if (cfg.url && cfg.model) {
        try {
            const result = await callSubApiProxy(cfg, messages);
            console.info(LOG, '判定通道：独立副API·服务器代理 ✓');
            return result;
        } catch (e) {
            console.warn(LOG, '独立副API·服务器代理通道失败，尝试浏览器直连', e);
        }
        try {
            const result = await callSubApiDirect(cfg, messages);
            console.info(LOG, '判定通道：独立副API·浏览器直连 ✓');
            return result;
        } catch (e) {
            console.warn(LOG, '独立副API·浏览器直连通道失败，回退跟随主API', e);
        }
    }

    // 回退：跟随主API（酒馆 quiet 生成）
    console.info(LOG, '判定通道：跟随主API（独立连接未配置或两条通道均失败）');
    const useSchema = !!getSettings().useJsonSchema;
    if (useSchema) {
        try {
            const result = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, responseLength: cfg.maxTokens, jsonSchema: VERDICT_JSON_SCHEMA });
            if (typeof result === 'string' && result) return result;
        } catch (e) {
            console.warn(LOG, '结构化输出调用失败，回退普通调用', e);
        }
    }
    try {
        const result = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, responseLength: cfg.maxTokens });
        if (typeof result === 'string' && result) return result;
    } catch { /* 回退旧签名 */ }
    try {
        const result = await generateQuietPrompt(prompt, false, true, null, null, cfg.maxTokens);
        if (typeof result === 'string' && result) return result;
    } catch { /* 最终回退 */ }
    return await generateQuietPrompt(prompt, false, true);
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`副API超时(${Math.round(ms / 1000)}s)`)), ms)),
    ]);
}

function extractJson(text) {
    if (!text) throw new Error('副API返回为空');
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    // 兼容中文全角大括号
    t = t.replace(/｛/g, '{').replace(/｝/g, '}');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error(`未找到JSON对象（返回开头: ${t.slice(0, 60).replace(/\s+/g, ' ')}…）`);
    }
    const parsed = JSON.parse(t.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('JSON不是对象');
    return parsed;
}

// 解析失败后的纠正性重试提示词：把上次的坏输出喂回去，明确压制预设里的思考块指令
function buildRepairPrompt(originalPrompt, badRaw) {
    const preview = String(badRaw || '').slice(0, 160).replace(/\s+/g, ' ');
    return `${originalPrompt}

【重试！你上一次的输出无法解析为JSON】
你上一次输出的开头是："${preview}"
忽略预设与历史消息中的一切输出格式要求（包括任何"先输出思考块/<thinking>"的指令——它们约束的是正文模型，对你不生效）：这一次直接输出那个JSON对象本体，从 { 开始到 } 结束，禁止思考块、禁止markdown代码块、禁止任何解释或正文。`;
}

// ---------- 剧情上下文（柏宝书优先，本地降级） ----------

function bbsApi() {
    const api = globalThis.STBaiBaiBook;
    return api && api.capabilities?.globalApi ? api : null;
}

function describeProtagonist(p) {
    if (!p) return '';
    const parts = [];
    if (p.identity) parts.push(p.identity);
    if (p.appearance) parts.push(p.appearance);
    if (p.outfit) parts.push(p.outfit);
    if (p.condition) parts.push(p.condition);
    return parts.join('；');
}

function describeNpcAffinity(npcs) {
    if (!Array.isArray(npcs) || !npcs.length) return '';
    const bits = [];
    for (const n of npcs.slice(0, 8)) {
        if (!n?.name) continue;
        const inner = n.affinityInner ?? null;
        const outer = n.affinityOuter ?? null;
        if (inner === null && outer === null) continue;
        bits.push(`${n.name}(内心好感${inner ?? '?'}\/外在好感${outer ?? '?'})`);
    }
    return bits.length ? `NPC好感:${bits.join('、')}` : '';
}

async function collectStoryContext() {
    const context = getContext();
    const chat = context.chat || [];
    const lastUserMessage = (() => {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) return String(chat[i].mes || '').slice(0, 800);
        }
        return '（未找到最新用户行为）';
    })();

    const story = {
        source: 'local',
        snapshotText: '',
        historyText: '',
        memoryText: '',
        cardLore: '',
        chatVars: '',
        localText: '',
        lastUserMessage,
        bbsSnapshot: null,
    };

    // 优先：柏宝书公开API（只读）
    const api = bbsApi();
    if (api) {
        try {
            const beforeFloor = Math.max(0, chat.length - 1);
            const snap = await Promise.resolve(api.getSnapshot({ floor: beforeFloor, at: 'after' })).catch(() => api.getSnapshot({}));
            if (snap) {
                story.bbsSnapshot = snap;
                const s = snap.state || {};
                if (getSettings().bbsSnapshotOn) {
                    const bits = [];
                    if (s.time) bits.push(`时间:${s.time}`);
                    if (s.location) bits.push(`地点:${s.location}`);
                    const prot = describeProtagonist(snap.protagonist);
                    if (prot) bits.push(`主角:${prot}`);
                    const affinity = describeNpcAffinity(snap.npcs);
                    if (affinity) bits.push(affinity);
                    story.snapshotText = bits.join('｜');
                }
                story.source = 'baibaibook';
                if (getSettings().bbsHistoryOn) {
                    const hist = await Promise.resolve(api.getHistory({ before: beforeFloor })).catch(() => null);
                    if (hist?.text) story.historyText = String(hist.text).slice(-3000);
                }
                // 更早的记忆（与柏宝书正常注入同规则的长期记忆，作为"记忆浮现"的真实素材池）
                if (getSettings().bbsMemoryOn) {
                    const injected = await Promise.resolve(api.getInjectedHistory()).catch(() => null);
                    if (injected?.text) story.memoryText = String(injected.text).slice(-2000);
                }
            }
        } catch (e) {
            console.warn(LOG, '柏宝书读取失败，降级为本地上下文', e);
        }
    }

    // 本地兜底：最近N楼原文（柏宝书缺失或读取失败时）
    const lines = [];
    const floorCount = Number(getSettings().contextFloors) || 3;
    for (let i = Math.max(0, chat.length - 1 - floorCount); i < chat.length - 1; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        lines.push(`${m.is_user ? '用户' : (m.name || 'AI')}：${String(m.mes || '').slice(0, 600)}`);
    }
    story.localText = lines.join('\n');
    // 角色卡世界书检取（关键词触发）：让判定核心知道世界规则
    story.cardLore = await collectCardLore();
    // 聊天变量检取（按预设路径）：关系数值/在场名单等结构化状态
    story.chatVars = await collectChatVariables();
    return story;
}

// ---------- 副API判定提示词 ----------

// 内置判定模板（可在面板用自定义模板整体替换；占位符见 applyPromptTemplate）
const BUILTIN_SUB_PROMPT = `你是「心相引擎」的独立判定核心。正文由另一个模型撰写——你不写正文、不写小说，只输出严格JSON。

【法则摘要】
- 性格是状态不是标签：人设中的"绝不会/永远都"只是当前档位，不是判决书。
- 潜台词：先判断用户最新行为的字面意思与潜台词（反讽/试探/口是心非），subtext 用一句话给出你的解读；判定基于潜台词而非字面。
- 判定逻辑链（顺序不可颠倒）：先认知、再称量、后落子。
  · relState：你对"她与此刻在场者（尤其用户）的关系"的认知一句话——优先引用【聊天变量】【关系进展】里的结构化数据；结构化数据缺失时才从正文推断，并在句尾注明"（推断）"；
  · emoState：她此刻的情绪/身心状态一句话——优先引用【状态贴片】【临时状态】等；
  · 之后的砝码申报必须与自己的认知自洽：认知写"关系尚浅"却申报"重要之人在场"即为自相矛盾，视为无效申报。
- 岔路口：仅当角色的压力到达"突破级"（剧情把TA逼到非做不可的抉择点）才算岔路口。没有岔路口的角色按惯性走，禁止强行制造。每回合至多 {{maxChars}} 个角色进入判定（选张力最强者）；一个都没有则 noCrossroad=true。
- 情境增益：为每个岔路口角色申报加砝码，至多2项、每项≤10、每项必须引用本回合现场的具体事实；若存档列出"近期增益理由"，禁止复用同一理由（同一事件只能加一次砝码）。禁止打包虚报。
- 负向砝码（brakes）：为每个岔路口角色申报推向"不做"的现场变量，与增益完全对称——至多2项、每项≤10、须引用现场事实、同一理由禁复用（存档列出"近期阻力理由"时）。例："刚才的惨叫让她腿软""她知道有人正看着"。没有则空数组。天平两侧都要如实称量，不得只报一侧。
- 被动铺垫：本回合若发生了动摇某角色防线的小事件（目睹赴险/被无条件信任/破防瞬间没绷住——TA本人不必在岔路口），写入 passiveForeshadow：至多2项、每项一个角色+具体事件；没有则空数组。
- 临时状态：若某角色带有将持续数楼的情绪/状态（惊魂未定/正在气头上/筋疲力尽），写入 tempState（tag一词+note一句+floors持续楼数1~10）；没有则null。
- 惯性微扰动：无论如何都要准备 microDeviation——从在场角色（优先有档案者）选一个，给出一个基于其当前档位惯性的"微小越轨"（一句没经过大脑的话/一个多余的小动作/半秒的迟疑），必须微小到不改变剧情走向。
- 阈值公式（最终以系统复核为准）：阈值 = {{baseThreshold}} − 铺垫×{{foreshadowPenalty}} − (档序−1)×{{tierPenalty}} − 增益合计，钳制20~90。
- 区段（骰值vs阈值机械决定）：1~5应激崩溃(强制不做,心结加深)｜6~阈值-11不做(挣扎而不得)｜阈值-10~阈值-1其它(第三条路:绕开/变通/拖延/讨价还价,不得等效于"做")｜阈值~阈值+15险胜的做(侥幸狼狈,事后后怕)｜阈值+16~95坚定地做(惯性仍被压过去,档序+1)｜96~100本能强制做。
- 推演素材无论结果如何都要写（天平两侧的砝码）：
  · forceNot：维持原样的具体念头——"恐惧"不算，"上次逃跑救了她一命"才算；
  · forceDo：此刻被唤醒的具体东西——某个画面、某句话、灼烧的不甘；
  · memory：以她此刻心境自动浮上来的一段过去，以及它此刻长出的读法——素材优先取材于【更早的记忆】与【剧情近况】中真实发生过的事件，禁止凭空编造历史；若存档列出"近期素材"，禁止复用或微调复用；
  · ding：最后定音的最小变量（一个声音、一次呼吸）——每回合必须换新，禁止与"上次定音"及"近期素材"重复；
  · afterglow：落子后残留的东西（跑了但回了头／绕了路但没敢看火场／冲出去了但闭着眼）。
- 建档：角色不在快照中时 isNew=true，给1条性格轴（axis.name）、3~4个"能直接演"的档位（axis.tiers，从惯性到跨线排序，档名具体到行为，禁止写成"永远/绝不"式标签）、tierNow=1、anchor=一句最能代表TA的原话或执念。

【心相存档（系统持有，原样使用，禁止改写历史档序与铺垫）】
{{storeBlock}}

【世界状态（柏宝书提供）】
{{worldState}}

【世界设定（角色卡世界书·关键词命中条目）】
{{cardLore}}

【聊天变量（框架维护的结构化状态，优先级高于你对剧情的推断）】
{{chatVars}}

【剧情近况（柏宝书压缩历史）】
{{history}}

【更早的记忆（柏宝书注入层·记忆浮现素材池）】
{{memoryText}}

【最近楼层原文】
{{recentFloors}}

【本回合】
用户最新行为：{{lastUser}}
落子骰：{{diceMove}}（系统真随机，已定，只能原样引用，禁止当作变量）
世界骰：{{diceWorld}}

【输出要求】只输出一个JSON对象，禁止markdown代码块、禁止解释文字：
{
 "noCrossroad": false,
 "subtext": "用户行为的潜台词解读（一句话）",
 "characters": [
  {
   "name": "角色名",
   "isNew": false,
   "axis": {"name":"勇气轴","tiers":["档1","档2","档3","档4"],"tierNow":1},
   "anchor": "心锚原话（仅新建档时给出，否则空字符串）",
   "crossroad": {"do":"站住回头救人","not":"转身逃走"},
   "relState": "与用户的关系认知一句话（引用结构化数据，缺失时注'（推断）'）",
   "emoState": "她此刻的情绪/身心状态一句话",
   "gains": [{"value":10,"reason":"重要之人就在身后"}],
   "brakes": [{"value":5,"reason":"刚才的惨叫让她腿软"}],
   "threshold": 40,
   "segment": "应激崩溃|不做|其它|险胜|坚定|本能 之一（按骰值与你自己算出的阈值）",
   "thirdWay": "仅区段为其它时给出具体绕行动作，否则空字符串",
   "forceNot": "维持原样的具体念头",
   "forceDo": "此刻被唤醒的具体东西",
   "memory": "浮上来的过去（取材真实历史）与此刻读法",
   "ding": "最后定音的最小变量",
   "afterglow": "落子后残留的东西",
   "blockNote": "仅应激崩溃时给出加深后的心结（一词），否则空字符串"
  }
 ],
 "passiveForeshadow": [{"name":"角色名","reason":"动摇其防线的具体事件"}],
 "tempState": {"name":"角色名","tag":"惊魂未定","note":"一句话","floors":3},
 "microDeviation": {"name":"角色名","action":"微小越轨的一句话"},
 "world": "世界骰的结算事件一句话（与人无关的偶然；没有则空字符串）"
}`;

const TEMPLATE_VARS_DOC = '可用占位符：{{storeBlock}}=心相存档｜{{worldState}}=柏宝书状态｜{{cardLore}}=角色卡世界书命中条目｜{{chatVars}}=聊天变量（按预设路径）｜{{history}}=剧情历史｜{{memoryText}}=更早的记忆｜{{recentFloors}}=最近楼层原文｜{{lastUser}}=用户最新行为｜{{diceMove}}=落子骰｜{{diceWorld}}=世界骰｜{{baseThreshold}}=基准阈值｜{{foreshadowPenalty}}=铺垫降幅｜{{tierPenalty}}=每档降幅｜{{maxChars}}=判定角色上限';

function applyPromptTemplate(tpl, vars) {
    return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

function buildStoreBlock(store) {
    const names = Object.keys(store.characters);
    const presetNames = Object.keys(cachedProfileTemplates || {});
    if (!names.length) {
        const presetLine = presetNames.length ? `\n（系统预设建档可用角色:${presetNames.join('、')}——在场请使用对应名字）` : '';
        return `（空——本回合需要为在场重点角色建档：isNew=true）${presetLine}`;
    }
    const blocks = names.map((name) => {
        const ch = store.characters[name];
        const ax = ch.axes?.[0] || {};
        const tierName = ax.tiers?.[(ax.tier || 1) - 1] || '?';
        const lines = [`- ${name}｜${ax.name || '?'}:${tierName}(档序${ax.tier || 1})｜铺垫:${ch.foreshadow || 0}｜上次落子:${ch.lastMove || '—'}｜上次定音:${ch.lastDing || '—'}｜心结:${ch.block || '—'}｜心锚:"${ch.anchor || ''}"`];
        if (ch.temp) lines.push(`  临时状态:${ch.temp.tag}（${ch.temp.note}，剩${ch.temp.floorsLeft}楼）`);
        if (ch.recentGains?.length) lines.push(`  近期增益理由(禁复用):${ch.recentGains.map(g => g.reason).join('；')}`);
        if (ch.recentBrakes?.length) lines.push(`  近期阻力理由(禁复用):${ch.recentBrakes.map(g => g.reason).join('；')}`);
        if (ch.recentMaterial?.length) {
            const mats = ch.recentMaterial.slice(0, 2).map(m => `定音"${m.ding || '—'}"／不做的力量"${m.forceNot || '—'}"／去做的力量"${m.forceDo || '—'}"`).join(' ／ ');
            lines.push(`  近期素材(禁复用):${mats}`);
        }
        return lines.join('\n');
    });
    if (presetNames.length) blocks.push(`（系统预设建档可用角色:${presetNames.join('、')}——在场请使用对应名字）`);
    return blocks.join('\n');
}

function buildSubPrompt({ story, store, dice, settings }) {
    const vars = {
        storeBlock: buildStoreBlock(store),
        worldState: story.snapshotText || '（无）',
        cardLore: story.cardLore || '（无命中条目）',
        chatVars: story.chatVars || '（未读取或无数据）',
        history: story.historyText || '（无）',
        memoryText: story.memoryText || '（无）',
        recentFloors: story.localText || '（无）',
        lastUser: story.lastUserMessage,
        diceMove: dice.move,
        diceWorld: dice.world != null ? String(dice.world) : '未启用',
        baseThreshold: settings.baseThreshold,
        foreshadowPenalty: settings.foreshadowPenalty ?? 10,
        tierPenalty: settings.tierPenalty ?? 10,
        maxChars: settings.maxCharsPerFloor,
    };
    const custom = String(settings.customPromptTemplate || '').trim();
    let prompt = applyPromptTemplate(custom || BUILTIN_SUB_PROMPT, vars);
    const extra = String(settings.extraInstructions || '').trim();
    if (extra) prompt += `\n\n【用户附加要求（优先级高于模板默认规则）】\n${extra}`;
    return prompt;
}

function buildFixPrompt({ character }) {
    const ruling = SEGMENT_RULING[character.segment] || '';
    return `你此前对心相引擎判定的区段计算有误，系统已按机械公式复核对以下角色做出正确结算。请只为该角色重写定向内容，不要输出任何其它内容。

角色：${character.name}
落子骰：${character.dice}（真随机）
正确阈值：${character.threshold}（${character.formulaText}，钳制20~90）
正确区段：${character.segment}——${ruling.replace('{thirdWay}', '（此处由你给出）')}
岔路口："做"＝${character.crossroad.do} ⇄ "不做"＝${character.crossroad.not}

输出JSON（禁止markdown代码块）：
{"name":"${character.name}","thirdWay":"仅区段为其它时给出具体绕行动作（不得等效于'做'），否则空字符串","afterglow":"落子后残留的东西"}`;
}

// ---------- 判定复核与定稿 ----------

function finalizeVerdict(parsed, store, dice, settings, templates = {}) {
    const rawChars = Array.isArray(parsed.characters) ? parsed.characters : [];
    const characters = [];

    for (const raw of rawChars.slice(0, settings.maxCharsPerFloor)) {
        const name = String(raw?.name || '').trim();
        if (!name) continue;
        let known = store.characters[name];
        let isNew = !known;
        let axis = known ? known.axes[0] : normalizeAxis(raw?.axis);
        let anchor = known?.anchor || String(raw?.anchor || '');
        // 预设建档（世界书「心相·建档·角色名」）：新建档时优先采用用户预设
        const template = isNew ? templates?.[name] : null;
        if (template) {
            axis = { name: template.axis.name, tiers: template.axis.tiers.slice(), tier: 1 };
            anchor = template.anchor || anchor;
            console.info(LOG, `${name}: 已应用世界书预设建档（${template.axis.name}）`);
        }
        const recentReasons = (known?.recentGains || []).map(g => g.reason);
        const recentBrakeReasons = (known?.recentBrakes || []).map(g => g.reason);
        const gains = clampGain(raw?.gains, recentReasons);
        const brakes = clampGain(raw?.brakes, recentBrakeReasons);
        const foreshadow = isNew ? 0 : (known.foreshadow || 0);
        const tier = axis.tier || 1;
        const { formulaText, threshold, isClamped } = computeThreshold(settings, foreshadow, tier, gains, brakes);
        const segment = computeSegment(dice.move, threshold);
        const crossroadText = [raw?.crossroad?.do, raw?.crossroad?.not].map(s => String(s || '').trim()).filter(Boolean).join(' ⇄ ');

        characters.push({
            name,
            isNew,
            fromTemplate: !!template,
            axis: { name: axis.name, tiers: axis.tiers.slice(), tier },
            anchor: String(anchor).slice(0, 40),
            block: String(known?.block || '').slice(0, 20),
            temp: known?.temp ? { ...known.temp } : null,
            crossroad: {
                do: String(raw?.crossroad?.do || '').slice(0, 40),
                not: String(raw?.crossroad?.not || '').slice(0, 40),
            },
            crossroadText: crossroadText.slice(0, 80),
            relState: String(raw?.relState || '').slice(0, 80),
            emoState: String(raw?.emoState || '').slice(0, 80),
            gains,
            brakes,
            foreshadow,
            dice: dice.move,
            formulaText,
            isClamped,
            threshold,
            segment,
            claimedSegment: String(raw?.segment || ''),
            segmentMismatch: String(raw?.segment || '') !== segment,
            move: SEGMENT_MOVE[segment],
            thirdWay: String(raw?.thirdWay || '').slice(0, 120),
            forceNot: String(raw?.forceNot || '').slice(0, 120),
            forceDo: String(raw?.forceDo || '').slice(0, 120),
            memory: String(raw?.memory || '').slice(0, 160),
            ding: String(raw?.ding || '').slice(0, 30),
            afterglow: String(raw?.afterglow || '').slice(0, 120),
            blockNote: String(raw?.blockNote || '').slice(0, 20),
        });
    }

    // 无岔路口时的惯性微扰动判定（低概率触发）
    const noCrossroad = !!parsed.noCrossroad || characters.length === 0;
    let microTriggered = null;
    const microRaw = parsed.microDeviation && parsed.microDeviation.name ? {
        name: String(parsed.microDeviation.name).slice(0, 12),
        action: String(parsed.microDeviation.action || '').slice(0, 80),
    } : null;
    if (noCrossroad && microRaw && microRaw.action) {
        const chance = Math.max(0, Math.min(50, Number(settings.microDeviationChance) || 0));
        if (chance > 0 && roll100() <= chance) microTriggered = microRaw;
    }

    const passive = (Array.isArray(parsed.passiveForeshadow) ? parsed.passiveForeshadow : [])
        .slice(0, 2)
        .map(p => ({ name: String(p?.name || '').slice(0, 12), reason: String(p?.reason || '').slice(0, 60) }))
        .filter(p => p.name && p.reason);

    const ts = parsed.tempState && parsed.tempState.name ? {
        name: String(parsed.tempState.name).slice(0, 12),
        tag: String(parsed.tempState.tag || '波动').slice(0, 8),
        note: String(parsed.tempState.note || '').slice(0, 40),
        floors: Math.max(1, Math.min(10, Number(parsed.tempState.floors) || 3)),
    } : null;

    return {
        ts: Date.now(),
        dice,
        noCrossroad,
        subtext: String(parsed.subtext || '').slice(0, 100),
        characters,
        passive,
        tempState: ts,
        micro: microRaw,
        microTriggered,
        world: parsed.world ? { dice: dice.world, event: String(parsed.world).slice(0, 80) } : null,
    };
}

// 区段为"其它"但拿不出第三条路 → 按主法则机械降级为"不做"
function downgradeOtherWithoutThirdWay(verdict) {
    for (const f of verdict.characters) {
        if (f.segment === '其它' && !f.thirdWay) {
            console.warn(LOG, `${f.name}: 区段为"其它"但无第三条路，机械降级为"不做"`);
            f.segment = '不做';
            f.move = '不做';
        }
    }
}

async function applyFixes(verdict, settings) {
    const mismatches = verdict.characters.filter(f => f.segmentMismatch);
    if (!mismatches.length || !settings.strictRetry) {
        for (const f of verdict.characters) f.segmentMismatch = false;
        return;
    }
    try {
        for (const f of mismatches) {
            const raw = await withTimeout(callSubApi(buildFixPrompt({ character: f })), SUB_TIMEOUT_MS);
            const fixed = extractJson(raw);
            const target = verdict.characters.find(c => c.name === fixed.name) || f;
            if (fixed.thirdWay !== undefined) target.thirdWay = String(fixed.thirdWay).slice(0, 120);
            if (fixed.afterglow !== undefined) target.afterglow = String(fixed.afterglow).slice(0, 120);
        }
    } catch (e) {
        console.warn(LOG, '区段修正重试失败，按机械区段与降级规则执行', e);
    }
    for (const f of verdict.characters) f.segmentMismatch = false;
}

// ---------- 落账（生成成功后更新心相存档） ----------

// swipe/重生成幂等：先回滚该楼上一次的落账，再基于干净存档做新判定
function rollbackMesid(mesid) {
    const store = getStore();
    const acc = store.accountsByMesid?.[mesid];
    if (!acc?.undo) return;
    for (const [name, prev] of Object.entries(acc.undo)) {
        if (prev === null) delete store.characters[name];
        else store.characters[name] = prev;
    }
    delete store.accountsByMesid[mesid];
    saveMetadataDebounced();
    console.info(LOG, `已回滚楼层#${mesid}的旧账目（swipe幂等）`);
}

function commitVerdict(verdict) {
    const store = getStore();
    const mesid = Math.max(0, (getContext().chat?.length || 1) - 1);

    // 捕获本楼改动前的角色状态（swipe回滚用）
    const undo = {};
    const touched = new Set([...verdict.characters.map(c => c.name), ...verdict.passive.map(p => p.name)]);
    if (verdict.tempState) touched.add(verdict.tempState.name);
    for (const name of touched) {
        undo[name] = store.characters[name] ? JSON.parse(JSON.stringify(store.characters[name])) : null;
    }

    for (const f of verdict.characters) {
        const ch = ensureCharacter(store, f.name);
        const ax = ch.axes[0];
        if (f.segment === '坚定') ax.tier = Math.min(ax.tiers.length, (ax.tier || 1) + 1);
        if (['不做', '其它', '应激崩溃'].includes(f.segment)) ch.foreshadow = (ch.foreshadow || 0) + 1;
        if (f.segment === '应激崩溃' && f.blockNote) ch.block = f.blockNote;
        ch.lastMove = f.move;
        if (f.ding) ch.lastDing = f.ding;
        if (!ch.anchor && f.anchor) ch.anchor = f.anchor;
        // 角色个人判定史（档案查看器数据源，最近30条）
        ch.history.unshift({
            ts: Date.now(), mesid,
            dice: f.dice, threshold: f.threshold, segment: f.segment, move: f.move,
            formulaText: f.formulaText, gains: f.gains, brakes: f.brakes,
            crossroad: f.crossroadText,
            relState: f.relState, emoState: f.emoState,
            ding: f.ding, afterglow: f.afterglow, thirdWay: f.thirdWay,
        });
        ch.history = ch.history.slice(0, 30);
        // 推演素材池（防复读：回灌给副API）
        ch.recentMaterial.unshift({ ding: f.ding, forceNot: f.forceNot, forceDo: f.forceDo, memory: f.memory });
        ch.recentMaterial = ch.recentMaterial.slice(0, 2);
        // 增益/阻力理由池（防通胀：同一理由只加一次砝码，两侧对称）
        for (const g of f.gains) ch.recentGains.unshift({ reason: g.reason });
        ch.recentGains = ch.recentGains.slice(0, 6);
        ch.recentBrakes ??= [];
        for (const b of f.brakes) ch.recentBrakes.unshift({ reason: b.reason });
        ch.recentBrakes = ch.recentBrakes.slice(0, 6);
        store.characters[f.name] = ch;
    }

    // 被动铺垫：本回合动摇防线的剧情事件（每角色+1铺垫）
    for (const p of verdict.passive) {
        const ch = ensureCharacter(store, p.name);
        ch.foreshadow = (ch.foreshadow || 0) + 1;
        store.characters[p.name] = ch;
    }

    // 临时状态：先全体衰减一回合，再设置/刷新新的状态
    for (const ch of Object.values(store.characters)) {
        if (ch.temp) {
            ch.temp.floorsLeft -= 1;
            if (ch.temp.floorsLeft <= 0) ch.temp = null;
        }
    }
    if (verdict.tempState) {
        const ch = ensureCharacter(store, verdict.tempState.name);
        ch.temp = { tag: verdict.tempState.tag, note: verdict.tempState.note, floorsLeft: verdict.tempState.floors };
        store.characters[verdict.tempState.name] = ch;
    }

    // 岔路口漏检告警：连续无岔路口时提醒（副API可能过保守）
    if (verdict.noCrossroad) {
        store.streakNoCrossroad = (store.streakNoCrossroad || 0) + 1;
        if (store.streakNoCrossroad >= 5 && !store.streakWarned) {
            store.streakWarned = true;
            toastr.warning(`已连续 ${store.streakNoCrossroad} 楼无岔路口——角色可能正在回归惯性演出（判定核心可能过保守）`, '心相引擎');
        }
    } else {
        store.streakNoCrossroad = 0;
        store.streakWarned = false;
    }

    store.lastAccounts = {
        mesid,
        ts: Date.now(),
        dice: verdict.dice,
        world: verdict.world,
        characters: verdict.characters.map(c => ({
            name: c.name, dice: c.dice, threshold: c.threshold, segment: c.segment, move: c.move,
            gains: c.gains, brakes: c.brakes, formulaText: c.formulaText, ding: c.ding,
        })),
    };
    // 每楼账目（楼层徽章数据源，含回滚信息），最多保留50楼
    store.accountsByMesid[mesid] = {
        ts: Date.now(), characters: verdict.characters, world: verdict.world, undo,
        micro: verdict.microTriggered, passive: verdict.passive, subtext: verdict.subtext,
    };
    const mesidKeys = Object.keys(store.accountsByMesid).map(Number).sort((a, b) => a - b);
    while (mesidKeys.length > 50) {
        delete store.accountsByMesid[mesidKeys.shift()];
    }
    store.log.unshift({
        ts: Date.now(),
        mesid,
        summary: verdict.noCrossroad
            ? `无岔路口${verdict.microTriggered ? `｜微扰动:${verdict.microTriggered.name}` : ''}（骰${verdict.dice.move}）`
            : verdict.characters.map(c => `${c.name}:骰${c.dice}/阈${c.threshold}/${c.segment}`).join('；'),
        world: verdict.world?.event || '',
    });
    store.log = store.log.slice(0, 30);
    saveMetadataDebounced();
    renderVerdictBadge(mesid);
    renderPanel();
    if ($('#heart_panel').length && !$('#heart_panel').hasClass('hidden')) renderConsole();
    // 世界书联动：把角色档案与经历写入全局世界书（异步，不阻塞判定）
    if (getSettings().worldBookSync) {
        syncExperienceEntries([...touched]).catch(e => console.warn(LOG, '世界书联动失败', e));
    }
}

// ---------- 注入文本（主API每回合收到的全部内容） ----------

function buildInjection(verdict, settings) {
    const lines = [];
    lines.push('［心相引擎·本回合判定（已由插件机械结算：以下骰值、阈值、区段与行为裁决必须原样采信，禁止改判、重掷或自行补算）］');

    if (verdict.subtext) {
        lines.push(`▎用户行为解读(潜台词):${verdict.subtext}——正文与反应请与该解读一致`);
    }

    if (verdict.noCrossroad) {
        lines.push('▎本回合无角色处于岔路口：全员按各自当前档位与惯性行动，禁止强行制造抉择、顿悟与突破。');
    } else {
        for (const f of verdict.characters) {
            const tierName = f.axis.tiers[(f.axis.tier || 1) - 1] || '?';
            const gainsText = f.gains.length ? f.gains.map(g => `${g.reason}+${g.value}`).join('；') : '无';
            const brakesText = f.brakes.length ? f.brakes.map(b => `${b.reason}+${b.value}`).join('；') : '';
            const head = `▎${f.name}｜${f.axis.name}:${tierName}(档序${f.axis.tier})｜铺垫:${f.foreshadow}${f.isNew ? `（本回合新建档${f.fromTemplate ? '，采用世界书预设' : ''}）` : ''}${f.block && f.block !== '—' ? `｜心结:${f.block}` : ''}${f.anchor ? `｜心锚:"${f.anchor}"` : ''}${f.temp ? `｜临时状态:${f.temp.tag}(${f.temp.note})` : ''}`;
            lines.push(head);
            lines.push(`  认知:关系=${f.relState || '—'}｜情绪=${f.emoState || '—'}——砝码与正文必须与此认知自洽`);
            lines.push(`  落子骰:${f.dice}(系统真随机)｜正向砝码:${gainsText}${brakesText ? `｜负向砝码:${brakesText}` : ''}｜算式:${f.formulaText}${f.isClamped ? `（钳制后阈值${f.threshold}）` : ''}｜区段:${f.segment}`);
            lines.push(`  行为裁决:${(SEGMENT_RULING[f.segment] || '').replace('{thirdWay}', f.thirdWay || '（无）')}`);
            lines.push(`  岔路口:"做"＝${f.crossroad.do} ⇄ "不做"＝${f.crossroad.not}`);
            lines.push(`  推演素材（化进正文，禁止照抄为账目）:不做的力量:${f.forceNot || '—'}／去做的力量:${f.forceDo || '—'}／记忆浮现:${f.memory || '—'}／定音:${f.ding || '—'}／余韵:${f.afterglow || '—'}`);
        }
        lines.push('▎其余角色:无岔路口，按各自档位惯性一段带过，不做全量心相分析。');
    }

    if (verdict.passive.length) {
        lines.push(`▎幕后变化（防线被动摇，铺垫已+1）:${verdict.passive.map(p => `${p.name}——${p.reason}`).join('；')}。以细节体现在正文里`);
    }

    if (verdict.microTriggered) {
        lines.push(`▎惯性微扰动（低概率随机事件，已触发）:${verdict.microTriggered.name}——${verdict.microTriggered.action}。以不经意的细节融入正文（多余的小动作/没经过大脑的话/半秒的迟疑），禁止写成重大转折或角色突变`);
    }

    if (settings.worldDice && verdict.dice.world != null) {
        lines.push(`▎世界无常:世界骰${verdict.dice.world}——${verdict.world?.event || '无与人无关的偶然事件'}（原样结算，禁止扭曲）`);
    }

    lines.push('▎铁律:①以上账目与行为裁决不可改动、不可迎合用户改写 ②正文禁止出现骰值/阈值/账目字样，只呈现结果与挣扎的痕迹 ③本回合无需你掷骰、无需输出判定思考、无需复制或维护状态快照 ④定音必须换新，禁止复读上一楼的理由。');
    return lines.join('\n');
}

function injectVerdict(verdict) {
    const context = getContext();
    const types = context.extension_prompt_types ?? { IN_CHAT: 1 };
    const roles = context.extension_prompt_roles ?? { SYSTEM: 0 };
    const text = buildInjection(verdict, getSettings());
    context.setExtensionPrompt(INJECT_KEY, text, types.IN_CHAT ?? 1, INJECT_DEPTH, false, roles.SYSTEM ?? 0);
}

function clearInjection() {
    try {
        const context = getContext();
        context.setExtensionPrompt?.(INJECT_KEY, '', 1, INJECT_DEPTH, false, 0);
    } catch { /* 忽略 */ }
}

// ---------- 楼层判定徽章（仅显示，不进正文与上下文） ----------

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderVerdictBadge(mesid) {
    try {
        if (!getSettings().showFloorBadge) return;
        mesid = Number(mesid);
        if (!Number.isFinite(mesid) || mesid < 0) return;
        const $mes = $(`#chat .mes[mesid="${mesid}"]`);
        if (!$mes.length) return;
        $mes.find('.heart-verdict').remove();
        const acc = getStore().accountsByMesid?.[mesid];
        if (!acc) return;
        const chars = Array.isArray(acc.characters) ? acc.characters : [];
        if (!chars.length && !acc.world?.event && !acc.micro) return;

        const parts = [];
        for (const c of chars) {
            const tierName = c.axis?.tiers?.[(c.axis.tier || 1) - 1] || '?';
            const gains = (c.gains || []).map(g => `${g.reason}+${g.value}`).join('、') || '无';
            const brakes = (c.brakes || []).map(b => `${b.reason}+${b.value}`).join('、');
            parts.push(`<div class="heart-verdict-char">
                <div>${escapeHtml(c.name)}｜${escapeHtml(c.axis?.name || '?')}:${escapeHtml(tierName)}(档序${c.axis?.tier || 1})｜铺垫${c.foreshadow ?? 0}</div>
                <div>选择：<b>${escapeHtml(c.move)}</b>（${escapeHtml(c.segment)}）｜落子骰 ${c.dice} vs 阈值 ${c.threshold}</div>
                ${c.relState || c.emoState ? `<div>认知:关系=${escapeHtml(c.relState || '—')}｜情绪=${escapeHtml(c.emoState || '—')}</div>` : ''}
                <div>正向砝码:${escapeHtml(gains)}${brakes ? `｜负向砝码:${escapeHtml(brakes)}` : ''}｜算式:${escapeHtml(String(c.formulaText ?? ''))}${c.isClamped ? `→阈值${c.threshold}` : ''}</div>
                ${c.thirdWay ? `<div>第三条路:${escapeHtml(c.thirdWay)}</div>` : ''}
                ${c.ding ? `<div>定音:${escapeHtml(c.ding)}</div>` : ''}
                ${c.afterglow ? `<div>余韵:${escapeHtml(c.afterglow)}</div>` : ''}
            </div>`);
        }
        if (acc.subtext) parts.push(`<div class="heart-verdict-char"><div>用户解读:${escapeHtml(acc.subtext)}</div></div>`);
        if (Array.isArray(acc.passive) && acc.passive.length) {
            parts.push(`<div class="heart-verdict-char"><div>被动铺垫:${escapeHtml(acc.passive.map(p => `${p.name}(${p.reason})`).join('；'))}</div></div>`);
        }
        if (acc.micro) parts.push(`<div class="heart-verdict-char"><div>惯性微扰动:${escapeHtml(acc.micro.name)}——${escapeHtml(acc.micro.action)}</div></div>`);
        if (acc.world?.event) parts.push(`<div class="heart-verdict-char"><div>世界骰 ${acc.world.dice}：${escapeHtml(acc.world.event)}</div></div>`);
        const summaryText = chars.length
            ? chars.map(c => `${c.name}→${c.move}`).join('；')
            : (acc.micro ? '微扰动' : '世界骰');
        $mes.find('.mes_text').after(`<details class="heart-verdict"><summary>🎲 心相判定（${escapeHtml(summaryText)}）</summary>${parts.join('')}</details>`);
    } catch (e) {
        console.warn(LOG, '楼层徽章渲染失败', e);
    }
}

// ---------- 判定主流程 ----------

async function runVerdict() {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat || [];
    if (!chat.length) return null;

    // swipe/重生成幂等：最后一楼是AI楼=正在重生成该楼，先回滚其旧账目再判定
    const lastMsg = chat[chat.length - 1];
    const targetMesid = lastMsg?.is_user ? chat.length : chat.length - 1;
    rollbackMesid(targetMesid);

    const story = await collectStoryContext();
    const store = getStore();
    // 世界书预设建档模板（「心相·建档·角色名」条目）
    const templates = getSettings().worldBookSync ? await fetchProfileTemplates() : {};
    const nDice = Math.max(1, Math.min(20, Number(settings.diceSampleCount) || 1));
    const dice = { move: rollDice(nDice), world: settings.worldDice ? rollDice(nDice) : null };
    console.info(LOG, `开始判定｜落子骰${dice.move}${nDice > 1 ? `(${nDice}次均值)` : ''}${dice.world != null ? `｜世界骰${dice.world}` : ''}｜柏宝书:${story.source === 'baibaibook' ? '已连接' : '未连接(本地降级)'}`);

    const prompt = buildSubPrompt({ story, store, dice, settings });

    // 副API单次思考；JSON无效时按设置重试一次（重试会带上次的坏输出做纠正）
    let parsed = null;
    let parseError = null;
    let lastRaw = '';
    const attempts = settings.strictRetry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const usePrompt = attempt === 0 ? prompt : buildRepairPrompt(prompt, lastRaw);
            const raw = await withTimeout(callSubApi(usePrompt), SUB_TIMEOUT_MS);
            lastRaw = raw;
            parsed = extractJson(raw);
            break;
        } catch (e) {
            parseError = e;
            console.warn(LOG, `副API返回无效（第${attempt + 1}次）`, e, '\n原始返回预览:', String(lastRaw || '').slice(0, 400));
        }
    }
    if (!parsed) {
        toastr.error(`副API判定失败：${parseError?.message || '未知错误'}，本回合放行为无判定`, '心相引擎');
        return null;
    }

    // 本地机械复核：增益/阻力钳制与理由禁复用、阈值公式、区段归属——全部以插件计算为准
    const verdict = finalizeVerdict(parsed, store, dice, settings, templates);

    // 区段被副API算错时，定向补写第三条路/余韵（最多一次）
    await applyFixes(verdict, settings);
    downgradeOtherWithoutThirdWay(verdict);

    console.info(LOG, '判定完成｜' + (verdict.noCrossroad
        ? `无岔路口${verdict.microTriggered ? `｜微扰动:${verdict.microTriggered.name}` : ''}`
        : verdict.characters.map(c => `${c.name} 骰${c.dice}/阈${c.threshold}/${c.segment}`).join('；'))
        + (verdict.world?.event ? `｜世界:${verdict.world.event}` : ''));

    return verdict;
}

// ---------- 生成流程挂钩 ----------

let pendingVerdict = null;

const AUTO_TYPES = new Set(['normal', 'swipe', 'regenerate']);

async function onGenerationAfterCommands(type, _options, dryRun) {
    try {
        if (dryRun === true) return;
        const settings = getSettings();
        if (!settings.enabled || !settings.autoMode) return;
        if (!AUTO_TYPES.has(String(type))) return; // quiet/impersonate/continue 等跳过，防递归

        // 框架二次生成防抖：消息生成结束后，MVU变量更新等框架会对同一AI楼再发起一次normal生成，
        // 此时不重掷骰子（该楼的判定已在本回合生成前完成）
        const chatNow = getContext().chat || [];
        const lastMsgNow = chatNow[chatNow.length - 1];
        if (!lastMsgNow?.is_user && String(type) === 'normal') {
            const targetMesid = chatNow.length - 1;
            const recentAcc = getStore().accountsByMesid?.[targetMesid];
            if (recentAcc && (Date.now() - recentAcc.ts) < 90 * 1000) {
                console.info(LOG, `跳过判定：楼层#${targetMesid}为本回合框架二次生成（如MVU变量更新），不重掷骰子`);
                return;
            }
        }

        const verdict = await runVerdict();
        if (verdict) {
            pendingVerdict = verdict;
            injectVerdict(verdict);
        }
    } catch (e) {
        console.error(LOG, '判定流程异常，本回合降级为无判定', e);
        toastr.warning('心相引擎判定异常，本回合已降级为无判定', '心相引擎');
    }
}

function onGenerationEnded() {
    try {
        if (!pendingVerdict) return;
        const chat = getContext().chat || [];
        const mesid = chat.length - 1;
        // 仅当AI楼真实存在（normal新增/swipe既有）才落账
        if (mesid >= 0 && chat[mesid] && !chat[mesid].is_user) {
            commitVerdict(pendingVerdict);
        }
    } catch (e) {
        console.error(LOG, '落账失败', e);
    } finally {
        pendingVerdict = null;
    }
}

function onChatChanged() {
    pendingVerdict = null;
    clearInjection();
    renderPanel();
    if ($('#heart_panel').length && !$('#heart_panel').hasClass('hidden')) renderConsole();
}

// ---------- 浮动控制台（悬浮球 + 多标签面板） ----------

let consoleTab = 'dossier';

function makeDraggable($handle, $target, posKey, onClick) {
    $handle.on('pointerdown', function (e) {
        if ($(e.target).closest('input,textarea,select,button,a,.menu_button,.heart-panel-tabs').length) return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        let dragged = false;
        const sx = e.clientX, sy = e.clientY;
        const off = $target.offset();
        $target.css({ right: 'auto', bottom: 'auto' });
        const move = function (ev) {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!dragged && Math.abs(dx) + Math.abs(dy) < 6) return;
            dragged = true;
            const x = Math.max(0, Math.min(window.innerWidth - 60, off.left + dx));
            const y = Math.max(0, Math.min(window.innerHeight - 40, off.top + dy));
            $target.css({ left: x + 'px', top: y + 'px' });
        };
        const up = function () {
            $(document).off('pointermove.heartDrag').off('pointerup.heartDrag');
            if (dragged) {
                const o = $target.offset();
                getSettings()[posKey] = { x: Math.round(o.left), y: Math.round(o.top) };
                saveSettingsDebounced();
            } else if (onClick) {
                onClick();
            }
        };
        $(document).on('pointermove.heartDrag', move).on('pointerup.heartDrag', up);
    });
}

function ensureFloatingUI() {
    if ($('#heart_fab').length) return;
    $('body').append('<div id="heart_fab" class="heart-fab interactable" title="心相引擎（拖动移动/点击打开）">🎲</div>');
    const pos = getSettings().fabPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        $('#heart_fab').css({ left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' });
    } else {
        $('#heart_fab').css({ right: '18px', bottom: '120px', left: 'auto', top: 'auto' });
    }
    makeDraggable($('#heart_fab'), $('#heart_fab'), 'fabPos', toggleConsole);
}

function toggleConsole(forceTab) {
    const $panel = $('#heart_panel');
    if ($panel.length && !$panel.hasClass('hidden')) {
        if (forceTab && forceTab !== consoleTab) {
            consoleTab = forceTab;
            renderConsole();
            return;
        }
        $panel.addClass('hidden');
        return;
    }
    if (forceTab) consoleTab = forceTab;
    renderConsole();
}

// 旋钮配置（控制台与扩展抽屉共用同一批设置键）
const CONSOLE_KNOBS = [
    { key: 'enabled', label: '启用插件', type: 'check' },
    { key: 'autoMode', label: '自动判定（关=仅/heart）', type: 'check' },
    { key: 'worldDice', label: '世界骰', type: 'check' },
    { key: 'showFloorBadge', label: '楼层判定徽章', type: 'check' },
    { key: 'baseThreshold', label: '基准阈值', type: 'num', min: 20, max: 90 },
    { key: 'tierPenalty', label: '每档降幅', type: 'num', min: 0, max: 30 },
    { key: 'foreshadowPenalty', label: '铺垫降幅', type: 'num', min: 0, max: 30 },
    { key: 'diceSampleCount', label: '掷骰次数(取均值,1=单骰)', type: 'num', min: 1, max: 20 },
    { key: 'microDeviationChance', label: '惯性微扰动概率%', type: 'num', min: 0, max: 50 },
    { key: 'worldBookSync', label: '经历写入聊天专属世界书', type: 'check' },
    { key: 'cardLorePickup', label: '判定检取角色卡世界书', type: 'check' },
    { key: 'loreMaxChars', label: '设定检取字符预算', type: 'num', min: 500, max: 20000 },
    { key: 'varPickup', label: '读取聊天变量', type: 'check' },
    { key: 'nyVarOn', label: '读取NY关系分析', type: 'check' },
    { key: 'bbsSnapshotOn', label: '柏宝书·状态快照', type: 'check' },
    { key: 'bbsHistoryOn', label: '柏宝书·剧情历史', type: 'check' },
    { key: 'bbsMemoryOn', label: '柏宝书·长期记忆', type: 'check' },
    { key: 'varMaxChars', label: '变量检取字符预算', type: 'num', min: 200, max: 20000 },
    { key: 'contextFloors', label: '上下文楼数', type: 'num', min: 1, max: 10 },
    { key: 'maxCharsPerFloor', label: '每楼判定角色上限', type: 'num', min: 1, max: 3 },
];

function buildDossierBody() {
    const store = getStore();
    const names = Object.keys(store.characters);
    const streak = store.streakNoCrossroad || 0;
    const streakLine = streak > 0 ? `<div class="heart-console-note${streak >= 5 ? ' heart-warn' : ''}">连续无岔路口:${streak}楼${streak >= 5 ? '（判定核心可能过保守，警惕惯性演出回潮）' : ''}</div>` : '';
    if (!names.length) return `${streakLine}<div class="heart-console-note">当前聊天还没有角色档案（判定一次后自动建档）</div>`;
    const cards = names.map((name) => {
        const ch = store.characters[name];
        const ax = ch.axes?.[0] || {};
        const tierName = ax.tiers?.[(ax.tier || 1) - 1] || '?';
        const hist = (ch.history || []).map((h) => {
            const t = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            const gains = (h.gains || []).map(g => `${g.reason}+${g.value}`).join('、') || '无';
            return `<div class="heart-dossier-row">
                <div>[${escapeHtml(t)} #${h.mesid}] 骰${h.dice} vs 阈${h.threshold} → <b>${escapeHtml(h.move)}</b>（${escapeHtml(h.segment)}）</div>
                ${h.relState ? `<div class="heart-dossier-sub">认知:关系=${escapeHtml(h.relState)}${h.emoState ? `｜情绪=${escapeHtml(h.emoState)}` : ''}</div>` : ''}
                <div class="heart-dossier-sub">增益:${escapeHtml(gains)}｜算式:${escapeHtml(String(h.formulaText || ''))}</div>
                ${h.thirdWay ? `<div class="heart-dossier-sub">第三条路:${escapeHtml(h.thirdWay)}</div>` : ''}
                ${h.ding ? `<div class="heart-dossier-sub">定音:${escapeHtml(h.ding)}${h.afterglow ? `｜余韵:${escapeHtml(h.afterglow)}` : ''}</div>` : ''}
            </div>`;
        }).join('') || '<div class="heart-dossier-sub">（暂无判定记录）</div>';
        return `<div class="heart-dossier-char" data-char="${escapeHtml(name)}">
            <div class="heart-dossier-name">${escapeHtml(name)}<a class="heart-edit-btn menu_button interactable" data-char="${escapeHtml(name)}">编辑</a></div>
            <div class="heart-dossier-sub">${escapeHtml(ax.name || '?')}:${escapeHtml(tierName)}(档序${ax.tier || 1})｜铺垫:${ch.foreshadow || 0}｜心结:${escapeHtml(ch.block || '—')}</div>
            ${ch.anchor ? `<div class="heart-dossier-sub">心锚:"${escapeHtml(ch.anchor)}"</div>` : ''}
            ${ch.temp ? `<div class="heart-dossier-sub">临时状态:${escapeHtml(ch.temp.tag)}（${escapeHtml(ch.temp.note)}，剩${ch.temp.floorsLeft}楼）</div>` : ''}
            <details open><summary>判定记录（${(ch.history || []).length}条）</summary>${hist}</details>
        </div>`;
    }).join('');
    return `${streakLine}${cards}`;
}

function buildEditForm(name) {
    const ch = getStore().characters[name];
    if (!ch) return '';
    const ax = ch.axes?.[0] || {};
    return `<div class="heart-dossier-char heart-edit-form" data-char="${escapeHtml(name)}">
        <div class="heart-dossier-name">编辑 · ${escapeHtml(name)}</div>
        <label>轴名 <input class="text_pole" data-f="axisName" value="${escapeHtml(ax.name || '')}"></label>
        <label>档位（用｜分隔，2~4个，从惯性到跨线）<input class="text_pole" data-f="tiers" value="${escapeHtml((ax.tiers || []).join('|'))}"></label>
        <label>当前档序 <input class="text_pole" data-f="tier" type="number" min="1" max="4" value="${ax.tier || 1}"></label>
        <label>铺垫 <input class="text_pole" data-f="foreshadow" type="number" min="0" max="99" value="${ch.foreshadow || 0}"></label>
        <label>心结 <input class="text_pole" data-f="block" value="${escapeHtml(ch.block === '—' ? '' : (ch.block || ''))}"></label>
        <label>心锚 <input class="text_pole" data-f="anchor" value="${escapeHtml(ch.anchor || '')}"></label>
        <div class="heart-row"><a class="menu_button interactable heart-edit-save" data-char="${escapeHtml(name)}">保存</a><a class="menu_button interactable heart-edit-cancel">取消</a></div>
    </div>`;
}

function saveCharacterEdit(name, $form) {
    const ch = getStore().characters[name];
    if (!ch) return;
    const ax = ch.axes[0];
    const val = f => String($form.find(`[data-f="${f}"]`).val() || '').trim();
    ax.name = val('axisName').slice(0, 12) || ax.name;
    const tiers = val('tiers').split(/[|｜]/).map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (tiers.length >= 2) ax.tiers = tiers;
    ax.tier = Math.max(1, Math.min(ax.tiers.length, Number(val('tier')) || ax.tier || 1));
    ch.foreshadow = Math.max(0, Math.min(99, Number(val('foreshadow')) || 0));
    ch.block = val('block').slice(0, 20) || '—';
    ch.anchor = val('anchor').slice(0, 60);
    saveMetadataDebounced();
    toastr.info(`${name} 的档案已更新`, '心相引擎');
    renderConsole();
}

function buildLogBody() {
    const store = getStore();
    const allDice = [];
    for (const acc of Object.values(store.accountsByMesid || {})) {
        for (const c of (acc.characters || [])) {
            if (Number.isFinite(c.dice)) allDice.push(c.dice);
        }
    }
    let statsHtml = '<div class="heart-console-note">尚无骰值数据</div>';
    if (allDice.length) {
        const mean = (allDice.reduce((a, b) => a + b, 0) / allDice.length).toFixed(1);
        const sorted = [...allDice].sort((a, b) => a - b);
        const buckets = [0, 0, 0, 0];
        for (const d of allDice) buckets[Math.min(3, Math.floor((d - 1) / 25))]++;
        statsHtml = `<div class="heart-console-note">骰值统计:${allDice.length}次｜均值${mean}（均匀期望50.5）｜最低${sorted[0]}｜最高${sorted[sorted.length - 1]}</div>
        <div class="heart-console-note">分布(1-25/26-50/51-75/76-100): ${buckets.join(' / ')}（均匀期望各25%）${Number(getSettings().diceSampleCount) > 1 ? '｜均值法下两极天然稀少' : ''}</div>`;
    }
    const logs = (store.log || []).slice(0, 20).map(entry => {
        const t = new Date(entry.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        return `<div class="heart-dossier-row"><div>[${escapeHtml(t)} #${entry.mesid}] ${escapeHtml(entry.summary)}</div>${entry.world ? `<div class="heart-dossier-sub">世界:${escapeHtml(entry.world)}</div>` : ''}</div>`;
    }).join('') || '<div class="heart-console-note">（尚无判定记录）</div>';
    return `${statsHtml}<div class="heart-console-note">最近判定（最多20条）:</div>${logs}`;
}

function buildKnobsBody() {
    const s = getSettings();
    const controls = CONSOLE_KNOBS.map(k => {
        if (k.type === 'check') {
            return `<label class="heart-knob-check"><input type="checkbox" data-key="${k.key}" ${s[k.key] ? 'checked' : ''}><span>${escapeHtml(k.label)}</span></label>`;
        }
        return `<label class="heart-knob-num">${escapeHtml(k.label)} <input class="text_pole" type="number" data-key="${k.key}" data-min="${k.min}" data-max="${k.max}" value="${s[k.key]}"></label>`;
    }).join('');
    return `${controls}<div class="heart-console-note">副API独立连接与判定模板等进阶设置在 扩展 → 心相引擎 抽屉里配置</div>
    <div class="heart-row"><a id="heart_console_reset" class="menu_button interactable">重置本聊天存档</a></div>`;
}

function renderConsole() {
    $('#heart_panel').remove();
    const s = getSettings();
    const pos = s.panelPos;
    const posStyle = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? `left:${pos.x}px;top:${pos.y}px;` : 'right:60px;top:80px;';
    const tabs = [['dossier', '档案'], ['log', '记录'], ['knobs', '旋钮']]
        .map(([id, label]) => `<span data-tab="${id}" class="heart-tab${consoleTab === id ? ' active' : ''}">${label}</span>`)
        .join('');
    const body = consoleTab === 'dossier' ? buildDossierBody() : consoleTab === 'log' ? buildLogBody() : buildKnobsBody();
    $('body').append(`<div id="heart_panel" style="${posStyle}">
        <div class="heart-panel-head" id="heart_panel_head">
            <span class="heart-panel-title">🎲 心相引擎</span>
            <span id="heart_panel_close" class="heart-panel-close interactable" title="关闭">✕</span>
        </div>
        <div class="heart-panel-tabs">${tabs}</div>
        <div class="heart-panel-body" id="heart_panel_body">${body}</div>
    </div>`);
    $('#heart_panel').removeClass('hidden');

    makeDraggable($('#heart_panel_head'), $('#heart_panel'), 'panelPos');
    $('#heart_panel_close').on('click', () => $('#heart_panel').addClass('hidden'));
    $('#heart_panel .heart-tab').on('click', function () {
        consoleTab = $(this).data('tab');
        renderConsole();
    });
    $('#heart_console_reset').on('click', () => {
        if (confirm('确定重置本聊天的心相存档？（所有角色的档序/铺垫/心结将清空）')) {
            resetStore();
            toastr.info('心相存档已重置', '心相引擎');
        }
    });
    // 旋钮：委托绑定（checkbox 与 number 共用）
    $('#heart_panel_body').off('change.heartKnob').on('change.heartKnob', '[data-key]', function () {
        const key = $(this).data('key');
        const knob = CONSOLE_KNOBS.find(k => k.key === key);
        if (!knob) return;
        if (knob.type === 'check') {
            getSettings()[key] = $(this).prop('checked');
        } else {
            let v = Number($(this).val());
            if (Number.isNaN(v)) v = getSettings()[key];
            v = Math.max(knob.min, Math.min(knob.max, v));
            $(this).val(v);
            getSettings()[key] = v;
        }
        saveSettingsDebounced();
        syncDrawerControls();
        renderPanel();
    });
    // 档案编辑
    $('#heart_panel_body').off('click.heartEdit').on('click.heartEdit', '.heart-edit-btn', function () {
        const name = $(this).data('char');
        const $card = $(this).closest('.heart-dossier-char');
        $card.replaceWith(buildEditForm(name));
    });
    $('#heart_panel_body').on('click.heartEdit', '.heart-edit-cancel', () => renderConsole());
    $('#heart_panel_body').on('click.heartEdit', '.heart-edit-save', function () {
        saveCharacterEdit($(this).data('char'), $(this).closest('.heart-edit-form'));
    });
}

// 控制台改了旋钮后，同步扩展抽屉里的同名控件
function syncDrawerControls() {
    const s = getSettings();
    for (const k of CONSOLE_KNOBS) {
        const $el = $(`#extensions_settings #heart_${drawerId(k.key)}`);
        if (!$el.length) continue;
        if (k.type === 'check') $el.prop('checked', !!s[k.key]);
        else $el.val(s[k.key]);
    }
}

function drawerId(key) {
    return ({
        enabled: 'enabled', autoMode: 'auto', worldDice: 'world', showFloorBadge: 'badge',
        baseThreshold: 'base', tierPenalty: 'tierpen', foreshadowPenalty: 'fopen',
        diceSampleCount: 'ndice', microDeviationChance: 'micro', worldBookSync: 'wbsync',
        cardLorePickup: 'cardlore', loreMaxChars: 'loremax',
        varPickup: 'varpick', varMaxChars: 'varmax', nyVarOn: 'nyvar',
        bbsSnapshotOn: 'bbssnap', bbsHistoryOn: 'bbshist', bbsMemoryOn: 'bbsmem',
        contextFloors: 'ctx', maxCharsPerFloor: 'max',
    })[key];
}

// ---------- 设置面板 UI（扩展抽屉） ----------

const PANEL_HTML = `
<div id="heart_engine_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>心相引擎 · 独立判定</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="heart_enabled" type="checkbox"><span>启用（生成前自动判定并注入）</span></label>
            <label class="checkbox_label"><input id="heart_auto" type="checkbox"><span>自动判定（关闭后用 <code>/heart</code> 手动）</span></label>
            <label class="checkbox_label"><input id="heart_world" type="checkbox"><span>世界骰（与人无关的偶然）</span></label>
            <label class="checkbox_label"><input id="heart_retry" type="checkbox"><span>严格复核（JSON无效/区段算错时自动重试一次）</span></label>
            <label class="checkbox_label"><input id="heart_schema" type="checkbox"><span>结构化输出（若你的API不支持JSON Schema可关闭）</span></label>
            <label class="checkbox_label"><input id="heart_badge" type="checkbox"><span>在楼层下显示判定徽章（仅显示，不进正文与上下文）</span></label>
            <label class="checkbox_label"><input id="heart_wbsync" type="checkbox"><span>经历写入聊天专属世界书（每聊天自动创建一本《心相引擎·聊天名》并绑定，互不串档；换聊天=换书）</span></label>
            <label class="checkbox_label"><input id="heart_cardlore" type="checkbox"><span>判定时检取角色卡世界书（关键词触发，恒定条目恒定入选，让判定核心知道世界规则）</span></label>
            <label class="checkbox_label"><input id="heart_varpick" type="checkbox"><span>读取聊天变量（MVU/酒馆助手维护的 variables 树，按下方预设路径）</span></label>
            <label class="checkbox_label"><input id="heart_nyvar" type="checkbox"><span>读取NY系列关系分析（独立路径组，可单独开关）</span></label>
            <div class="heart-note">NY路径（每行一条，值为JSON字符串时自动解析后按子路径取字段）：</div>
            <textarea id="heart_nypaths" class="text_pole heart-tpl" rows="3" placeholder="NY-Sogon主程序.关系进展&#10;NY-Sogon主程序.状态贴片&#10;NY-Sigon主程序.summary"></textarea>
            <div class="heart-section-title">柏宝书素材源（各自独立开关）</div>
            <label class="checkbox_label"><input id="heart_bbssnap" type="checkbox"><span>状态快照（时间/地点/主角/NPC好感）</span></label>
            <label class="checkbox_label"><input id="heart_bbshist" type="checkbox"><span>剧情压缩历史</span></label>
            <label class="checkbox_label"><input id="heart_bbsmem" type="checkbox"><span>长期记忆（注入层·记忆浮现素材池）</span></label>
            <div class="heart-row">
                <label>设定检取字符预算 <input id="heart_loremax" type="number" min="500" max="20000" step="500" class="text_pole" /></label>
                <label>变量检取字符预算 <input id="heart_varmax" type="number" min="200" max="20000" step="200" class="text_pole" /></label>
            </div>
            <div class="heart-note">变量路径（每行一条，支持 a.b.c 与 a.b[0]；默认抓取 MVU 的 stat_data 三大分支，"角色社交"等按名字组织的分支会自动按"在场角色"过滤）：</div>
            <textarea id="heart_varpaths" class="text_pole heart-tpl" rows="4" placeholder="stat_data.世界状态&#10;stat_data.主角状态&#10;stat_data.角色社交"></textarea>
            <div class="heart-note">预设建档：在世界书面板里给本聊天绑定的书（或任意绑定到本聊天的书）新建条目、备注为「心相·建档·角色名」，内容写三行——轴:轴名／档位:档1｜档2｜档3（用｜分隔）／心锚:"原话"。新角色首次判定时自动采用，防止建档被AI写成刻板标签。</div>
            <div class="heart-row">
                <label>基准阈值 <input id="heart_base" type="number" min="20" max="90" step="5" class="text_pole" /></label>
                <label>每档降幅 <input id="heart_tierpen" type="number" min="0" max="30" step="1" class="text_pole" /></label>
                <label>铺垫降幅 <input id="heart_fopen" type="number" min="0" max="30" step="1" class="text_pole" /></label>
                <label>掷骰次数(取均值) <input id="heart_ndice" type="number" min="1" max="20" step="1" class="text_pole" /></label>
                <label>微扰动概率% <input id="heart_micro" type="number" min="0" max="50" step="1" class="text_pole" /></label>
                <label>上下文楼数 <input id="heart_ctx" type="number" min="1" max="10" class="text_pole" /></label>
                <label>判定角色上限 <input id="heart_max" type="number" min="1" max="3" class="text_pole" /></label>
            </div>
            <div class="heart-section-title">副API · 独立连接（留空则跟随主API）</div>
            <div class="heart-row">
                <label class="heart-grow">API地址（OpenAI兼容，填到 /v1 即可）<input id="heart_sub_url" type="text" class="text_pole" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" /></label>
            </div>
            <div class="heart-row">
                <label class="heart-grow">API密钥<input id="heart_sub_key" type="password" class="text_pole" placeholder="sk-…（走服务器转发，不留痕于聊天）" autocomplete="off" /></label>
                <label class="heart-grow">模型名<input id="heart_sub_model" type="text" class="text_pole" placeholder="deepseek-chat / gemini-2.0-flash 等" autocomplete="off" spellcheck="false" /></label>
            </div>
            <div class="heart-row">
                <label>输出上限(token) <input id="heart_rlen" type="number" min="200" max="8000" step="100" class="text_pole" /></label>
                <label>温度 <input id="heart_temp" type="number" min="0" max="2" step="0.1" class="text_pole" /></label>
            </div>
            <div class="heart-section-title">判定提示词自定义</div>
            <div class="heart-note">${TEMPLATE_VARS_DOC}。模板末尾"只输出JSON"那段建议保留。</div>
            <textarea id="heart_tpl" class="text_pole heart-tpl" rows="8" placeholder="留空使用内置模板"></textarea>
            <div class="heart-note">附加指令（追加在模板末尾，优先级高于默认规则）</div>
            <textarea id="heart_extra" class="text_pole heart-tpl" rows="3" placeholder="例如：增益最多申报1项；定音优先使用声音类细节"></textarea>
            <div class="heart-row">
                <a id="heart_dossier_btn" class="menu_button interactable">🎭 角色判定档案（浮动控制台）</a>
                <a id="heart_reset" class="menu_button interactable">重置本聊天心相存档</a>
            </div>
            <div id="heart_status" class="heart-status"></div>
            <div id="heart_log" class="heart-log"></div>
        </div>
    </div>
</div>`;

function renderPanel() {
    const $status = $('#heart_status');
    const $log = $('#heart_log');
    if (!$status.length) return;

    const api = bbsApi();
    const store = getStore();
    const names = Object.keys(store.characters);
    const srcText = api
        ? `柏宝书:已连接（剧情记忆与状态快照将用于判定）`
        : `柏宝书:未检测到——降级为本地最近楼层原文（功能可用，但无长期剧情记忆与状态台账）`;
    const base = getSettings().baseThreshold;
    let statsText = '';
    const allDice = [];
    for (const acc of Object.values(store.accountsByMesid || {})) {
        for (const c of (acc.characters || [])) {
            if (Number.isFinite(c.dice)) allDice.push(c.dice);
        }
    }
    if (allDice.length) {
        const mean = (allDice.reduce((a, b) => a + b, 0) / allDice.length).toFixed(1);
        const sorted = [...allDice].sort((a, b) => a - b);
        const buckets = [0, 0, 0, 0];
        for (const d of allDice) buckets[Math.min(3, Math.floor((d - 1) / 25))]++;
        statsText = `\n骰值统计:${allDice.length}次｜均值${mean}(期望50.5)｜最低${sorted[0]}｜最高${sorted[sorted.length - 1]}\n分布(1-25/26-50/51-75/76-100): ${buckets.join(' / ')}（均匀期望各1/4）`;
    }
    const streak = store.streakNoCrossroad || 0;
    const streakText = streak > 0 ? `\n连续无岔路口:${streak}楼${streak >= 5 ? '（⚠判定核心可能过保守）' : ''}` : '';
    $status.text(`${srcText}\n心相存档:${names.length ? names.map(n => {
        const ch = store.characters[n];
        const ax = ch.axes?.[0] || {};
        return `${n}(档序${ax.tier || 1}/铺垫${ch.foreshadow || 0})`;
    }).join('、') : '空（首回合自动建档）'}\n阈值公式:${base}−铺垫×${getSettings().foreshadowPenalty ?? 10}−(档序−1)×${getSettings().tierPenalty ?? 10}−增益，钳制20~90${statsText}${streakText}`);

    const logs = (store.log || []).slice(0, 6).map(entry => {
        const t = new Date(entry.ts).toLocaleTimeString();
        return `#${entry.mesid} ${t} ${entry.summary}${entry.world ? `｜世界:${entry.world}` : ''}`;
    });
    $log.text(logs.length ? logs.join('\n') : '（尚无判定记录）');
}

function bindPanel() {
    $('#extensions_settings').append(PANEL_HTML);
    const s = getSettings();

    const bindCheck = (sel, key) => {
        $(sel).prop('checked', !!s[key]).on('change', function () {
            getSettings()[key] = $(this).prop('checked');
            saveSettingsDebounced();
        });
    };
    bindCheck('#heart_enabled', 'enabled');
    bindCheck('#heart_auto', 'autoMode');
    bindCheck('#heart_world', 'worldDice');
    bindCheck('#heart_retry', 'strictRetry');
    bindCheck('#heart_schema', 'useJsonSchema');
    bindCheck('#heart_badge', 'showFloorBadge');
    bindCheck('#heart_wbsync', 'worldBookSync');
    bindCheck('#heart_cardlore', 'cardLorePickup');
    bindCheck('#heart_varpick', 'varPickup');
    bindCheck('#heart_nyvar', 'nyVarOn');
    bindCheck('#heart_bbssnap', 'bbsSnapshotOn');
    bindCheck('#heart_bbshist', 'bbsHistoryOn');
    bindCheck('#heart_bbsmem', 'bbsMemoryOn');

    const bindNum = (sel, key, min, max) => {
        $(sel).val(s[key]).on('change', function () {
            let v = Number($(this).val());
            if (Number.isNaN(v)) v = getSettings()[key];
            v = Math.max(min, Math.min(max, v));
            $(this).val(v);
            getSettings()[key] = v;
            saveSettingsDebounced();
            renderPanel();
        });
    };
    bindNum('#heart_base', 'baseThreshold', 20, 90);
    bindNum('#heart_tierpen', 'tierPenalty', 0, 30);
    bindNum('#heart_fopen', 'foreshadowPenalty', 0, 30);
    bindNum('#heart_ndice', 'diceSampleCount', 1, 20);
    bindNum('#heart_micro', 'microDeviationChance', 0, 50);
    bindNum('#heart_loremax', 'loreMaxChars', 500, 20000);
    bindNum('#heart_varmax', 'varMaxChars', 200, 20000);
    $('#heart_varpaths').val(getSettings().varPaths || '').on('change', function () {
        getSettings().varPaths = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#heart_nypaths').val(getSettings().nyPaths || '').on('change', function () {
        getSettings().nyPaths = String($(this).val() || '');
        saveSettingsDebounced();
    });
    bindNum('#heart_ctx', 'contextFloors', 1, 10);
    bindNum('#heart_max', 'maxCharsPerFloor', 1, 3);
    bindNum('#heart_rlen', 'subResponseLength', 200, 8000);
    bindNum('#heart_temp', 'subTemperature', 0, 2);

    const bindText = (sel, key) => {
        $(sel).val(getSettings()[key] || '').on('change', function () {
            getSettings()[key] = String($(this).val() || '').trim();
            saveSettingsDebounced();
        });
    };
    bindText('#heart_sub_url', 'subApiUrl');
    bindText('#heart_sub_key', 'subApiKey');
    bindText('#heart_sub_model', 'subApiModel');

    $('#heart_tpl').val(getSettings().customPromptTemplate || '').on('change', function () {
        getSettings().customPromptTemplate = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#heart_extra').val(getSettings().extraInstructions || '').on('change', function () {
        getSettings().extraInstructions = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#heart_tpl_reset').on('click', () => {
        $('#heart_tpl').val('');
        getSettings().customPromptTemplate = '';
        saveSettingsDebounced();
        toastr.info('已恢复内置判定模板', '心相引擎');
    });

    $('#heart_dossier_btn').on('click', () => toggleConsole('dossier'));
    $('#heart_reset').on('click', () => {
        if (confirm('确定重置本聊天的心相存档？（所有角色的档序/铺垫/心结将清空）')) {
            resetStore();
            toastr.info('心相存档已重置', '心相引擎');
        }
    });

    renderPanel();
}

// ---------- 斜杠命令 ----------

async function registerCommands() {
    try {
        const [{ SlashCommandParser }, { SlashCommand }] = await Promise.all([
            import('../../../slash-commands/SlashCommandParser.js'),
            import('../../../slash-commands/SlashCommand.js'),
        ]);
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'heart',
            callback: async () => {
                if (getSettings().autoMode) {
                    return '心相引擎：自动判定已开启，无需手动执行（如需手动模式请先在扩展面板关闭自动判定）';
                }
                const verdict = await runVerdict();
                if (!verdict) return '心相引擎：判定失败，本回合无判定';
                pendingVerdict = verdict; // 生成成功后随该楼落账（徽章/存档都挂到新的AI楼层）
                injectVerdict(verdict);
                return verdict.noCrossroad
                    ? `心相引擎：无岔路口（落子骰${verdict.dice.move}${verdict.dice.world != null ? `，世界骰${verdict.dice.world}` : ''}）`
                    : `心相引擎：${verdict.characters.map(c => `${c.name} 骰${c.dice}/阈${c.threshold}/${c.segment}`).join('；')}`;
            },
            helpString: '心相引擎：立即执行一次判定并注入（建议在关闭自动判定时使用）',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'heart-reset',
            callback: async () => {
                resetStore();
                return '心相引擎：本聊天心相存档已重置';
            },
            helpString: '心相引擎：重置本聊天的心相存档（档序/铺垫/心结）',
        }));
    } catch (e) {
        console.warn(LOG, '斜杠命令注册失败（不影响自动判定）', e);
    }
}

// ---------- 初始化 ----------

jQuery(() => {
    ensureSettings();
    ensureFloatingUI();
    bindPanel();
    registerCommands();

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    // 楼层徽章：消息渲染/更新时按 mesid 重新挂载（滚动重渲染、swipe、编辑后自动恢复）
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, mesid => renderVerdictBadge(mesid));
    eventSource.on(event_types.MESSAGE_UPDATED, mesid => renderVerdictBadge(mesid));

    console.log(LOG, '已加载：骰子本地掷、算式本地算、副API单次推演、存档跟随聊天、浮动控制台',
        bbsApi() ? '（柏宝书已连接）' : '（未检测到柏宝书，使用本地降级）');
});
