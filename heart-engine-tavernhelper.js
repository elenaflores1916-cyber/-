// 心相引擎 · 酒馆助手版 (Heart Engine for TavernHelper / JS-Slash-Runner)
// =====================================================================
// 这是「心相引擎 · 独立判定」扩展的酒馆助手脚本移植版。
// 导入方式：酒馆助手(JS-Slash-Runner) → 脚本库 → 导入脚本 → 选择本文件 → 启用。
//
// ⚠️ 重要：本脚本与同名酒馆扩展不能同时启用——两者都会在生成前判定，
//    同时开会双重掷骰。用脚本版时请先停用扩展版（反之亦然）。
//
// 依赖：酒馆助手 4.x（eventOn / generateRaw / injectPrompts / getVariables /
//       insertOrAssignVariables / getOrCreateChatWorldbook / getWorldbook /
//       replaceWorldbook / getCharWorldbookNames / getChatWorldbookName /
//       SillyTavern.getContext）。
// 柏宝书联动：尝试经 window.parent 读取其公开API，读不到则自动降级。

'use strict';

// ===================== 工具 =====================

const LOG = '[心相引擎·TH]';
const INJECT_ID = 'heart_engine_verdict_th';

function log(...a) { console.info(LOG, ...a); }
function warnLog(...a) { console.warn(LOG, ...a); }

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

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function clampNum(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// 无偏差 1d100 + N次取均值
function roll100() {
    const limit = Math.floor(0x100000000 / 100) * 100;
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return (buf[0] % 100) + 1;
}
function rollDice(sampleCount) {
    const n = clampNum(sampleCount, 1, 20, 10);
    if (n === 1) return roll100();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += roll100();
    return Math.round(sum / n);
}

// ===================== 设置（脚本变量持久化） =====================

const DEFAULT_SETTINGS = {
    enabled: true, autoMode: true, baseThreshold: 80,
    tierPenalty: 10, foreshadowPenalty: 10, diceSampleCount: 10,
    microDeviationChance: 5, contextFloors: 3, strictRetry: true,
    worldDice: true, maxCharsPerFloor: 2,
    varPickup: true,
    varPaths: 'stat_data.世界状态\nstat_data.主角状态\nstat_data.角色社交',
    nyVarOn: true,
    nyPaths: 'NY-Sogon主程序.关系进展\nNY-Sogon主程序.状态贴片\nNY-Sigon主程序.summary',
    varMaxChars: 3500,
    bbsSnapshotOn: true, bbsHistoryOn: true, bbsMemoryOn: true,
    cardLorePickup: true, loreMaxChars: 3000,
    worldBookSync: true, showFloorBadge: true,
    subApiUrl: '', subApiKey: '', subApiModel: '', subTemperature: 0.7,
};

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
    try {
        const saved = getVariables({ type: 'script' })?.heartSettings;
        if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) { warnLog('读取脚本设置失败', e); }
}

async function saveSettings() {
    try { insertOrAssignVariables({ heartSettings: settings }, { type: 'script' }); } catch (e) { warnLog('保存脚本设置失败', e); }
}

// ===================== 心相存档（聊天变量持久化） =====================

let store = null;

function freshStore() {
    return { version: 2, characters: {}, lastAccounts: null, log: [], accountsByMesid: {}, streakNoCrossroad: 0, streakWarned: false, wiBookName: '' };
}

function loadStore() {
    try {
        const saved = getVariables({ type: 'chat' })?.heartEngine;
        store = (saved && typeof saved === 'object') ? { ...freshStore(), ...saved } : freshStore();
    } catch (e) { warnLog('读取心相存档失败', e); store = freshStore(); }
    store.characters ??= {}; store.log ??= []; store.accountsByMesid ??= {};
    store.streakNoCrossroad ??= 0; store.streakWarned ??= false;
    return store;
}

function saveStore() {
    try { insertOrAssignVariables({ heartEngine: store }, { type: 'chat' }); } catch (e) { warnLog('保存心相存档失败', e); }
}

function resetStore() {
    store = freshStore(); saveStore(); renderConsole();
}

function ensureCharacter(name) {
    if (!name) return null;
    if (!store.characters[name]) {
        store.characters[name] = {
            axes: [{ name: '性格轴', tiers: ['惯性', '动摇', '跨线'], tier: 1 }],
            anchor: '', foreshadow: 0, lastMove: '—', lastDing: '—', block: '—',
            history: [], recentMaterial: [], recentGains: [], recentBrakes: [], temp: null,
        };
    }
    const ch = store.characters[name];
    ch.history ??= []; ch.recentMaterial ??= []; ch.recentGains ??= []; ch.recentBrakes ??= [];
    return ch;
}

// ===================== 算式与钳制 =====================

const SEGMENT_MOVE = { '应激崩溃': '不做', '不做': '不做', '其它': '其它', '险胜': '做', '坚定': '做', '本能': '做' };
const SEGMENT_RULING = {
    '应激崩溃': '强制"不做"——这是应激创伤反应，不是铺垫：心结加深，写失控崩溃的狼狈',
    '不做': '"不做"——挣扎而不得（腿在抖、喊不出来、迈不动步），这次失败成为下一次的砝码',
    '其它': '"其它"（第三条路）——既不冲上去也不逃走：{thirdWay}。必须绕开"做"的核心代价，只拿部分或延迟的结果，她心里知道自己绕了',
    '险胜': '"做"（险胜）——成是成了，但写足侥幸、狼狈、事后自己都后怕，惯性几乎压过去',
    '坚定': '"做"（坚定）——仍须写"惯性仍在、被压过去"，禁止云淡风轻（档序已由系统+1）',
    '本能': '"做"（本能强制）——身体先于大脑，事后她自己都会愣住',
};

function normalizeReason(s) { return String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ''); }

function reasonOverlaps(a, b) {
    a = normalizeReason(a); b = normalizeReason(b);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const grain = Math.min(6, a.length, b.length);
    if (grain < 4) return false;
    for (let i = 0; i + grain <= a.length; i++) if (b.includes(a.slice(i, i + grain))) return true;
    return false;
}

function clampGain(gains, recentReasons = []) {
    return (Array.isArray(gains) ? gains : [])
        .filter(g => g && (g.reason || '').toString().trim())
        .map(g => ({ value: Math.max(0, Math.min(10, Number(g.value) || 0)), reason: String(g.reason).slice(0, 30) }))
        .filter(g => g.value > 0)
        .filter(g => !recentReasons.some(r => reasonOverlaps(r, g.reason)))
        .slice(0, 2);
}

function computeThreshold(foreshadow, tier, gains, brakes = []) {
    const gainSum = gains.reduce((a, g) => a + g.value, 0);
    const brakeSum = brakes.reduce((a, g) => a + g.value, 0);
    const pF = Math.max(0, Number(settings.foreshadowPenalty ?? 10));
    const pT = Math.max(0, Number(settings.tierPenalty ?? 10));
    const formula = settings.baseThreshold - foreshadow * pF - (tier - 1) * pT - gainSum + brakeSum;
    let eq = `${settings.baseThreshold}−铺垫${foreshadow}×${pF}−(档序${tier}−1)×${pT}−增益${gainSum}`;
    if (brakeSum > 0) eq += `+阻力${brakeSum}`;
    return { formulaText: `${eq}＝${formula}`, threshold: Math.max(20, Math.min(90, formula)), isClamped: formula !== Math.max(20, Math.min(90, formula)) };
}

function computeSegment(dice, threshold) {
    if (dice <= 5) return '应激崩溃';
    if (dice < threshold - 10) return '不做';
    if (dice <= threshold - 1) return '其它';
    if (dice <= threshold + 15) return '险胜';
    if (dice <= 95) return '坚定';
    return '本能';
}

function normalizeAxis(raw) {
    const tiers = (Array.isArray(raw?.tiers) ? raw.tiers : []).map(t => String(t).slice(0, 30)).filter(Boolean).slice(0, 4);
    if (tiers.length < 2) tiers.push('动摇', '跨线');
    return { name: String(raw?.name || '性格轴').slice(0, 12), tiers, tier: 1 };
}

// ===================== 素材收集 =====================

function parentCtx() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function bbsApi() {
    try { const api = window.parent?.STBaiBaiBook; return api && api.capabilities?.globalApi ? api : null; } catch { return null; }
}

async function collectStoryContext() {
    const ctx = parentCtx();
    const chat = ctx?.chat || [];
    const lastUserMessage = (() => {
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) return String(chat[i].mes || '').slice(0, 800);
        return '（未找到最新用户行为）';
    })();

    const story = { source: 'local', snapshotText: '', historyText: '', memoryText: '', cardLore: '', chatVars: '', localText: '', lastUserMessage };

    // 柏宝书（经父窗口公开API，三项独立开关）
    const api = bbsApi();
    if (api) {
        try {
            const beforeFloor = Math.max(0, chat.length - 1);
            const snap = await Promise.resolve(api.getSnapshot({ floor: beforeFloor, at: 'after' })).catch(() => api.getSnapshot({}));
            if (snap) {
                story.source = 'baibaibook';
                if (settings.bbsSnapshotOn) {
                    const s = snap.state || {};
                    const bits = [];
                    if (s.time) bits.push(`时间:${s.time}`);
                    if (s.location) bits.push(`地点:${s.location}`);
                    const p = snap.protagonist || {};
                    const pp = [p.identity, p.appearance, p.outfit, p.condition].filter(Boolean).join('；');
                    if (pp) bits.push(`主角:${pp}`);
                    if (Array.isArray(snap.npcs) && snap.npcs.length) {
                        const aff = snap.npcs.slice(0, 8).filter(n => n?.name && (n.affinityInner != null || n.affinityOuter != null))
                            .map(n => `${n.name}(内心好感${n.affinityInner ?? '?'}/外在好感${n.affinityOuter ?? '?'})`);
                        if (aff.length) bits.push(`NPC好感:${aff.join('、')}`);
                    }
                    story.snapshotText = bits.join('｜');
                }
                if (settings.bbsHistoryOn) {
                    const hist = await Promise.resolve(api.getHistory({ before: beforeFloor })).catch(() => null);
                    if (hist?.text) story.historyText = String(hist.text).slice(-3000);
                }
                if (settings.bbsMemoryOn) {
                    const inj = await Promise.resolve(api.getInjectedHistory()).catch(() => null);
                    if (inj?.text) story.memoryText = String(inj.text).slice(-2000);
                }
            }
        } catch (e) { warnLog('柏宝书读取失败，降级本地', e); }
    }

    // 最近楼层原文
    const lines = [];
    const n = clampNum(settings.contextFloors, 1, 10, 3);
    for (let i = Math.max(0, chat.length - 1 - n); i < chat.length - 1; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        lines.push(`${m.is_user ? '用户' : (m.name || 'AI')}：${String(m.mes || '').slice(0, 600)}`);
    }
    story.localText = lines.join('\n');

    // 聊天变量（含NY），预算内按路径读取
    story.chatVars = await collectChatVariables();

    // 角色卡世界书（关键词触发）
    story.cardLore = await collectCardLore();

    return story;
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
    const matched = Object.keys(val).filter(k => names.some(n => k.includes(n) || n.includes(k)));
    if (!matched.length) return null;
    const out = {}; for (const k of matched) out[k] = val[k];
    return out;
}

function collectChatVariables() {
    try {
        if (!settings.varPickup && !settings.nyVarOn) return '';
        const root = getVariables({ type: 'chat' }) || {};
        const paths = [];
        if (settings.varPickup) {
            for (const l of String(settings.varPaths || '').split(/[\n,，;；]+/).map(x => x.trim()).filter(Boolean)) paths.push(l);
        }
        if (settings.nyVarOn) {
            for (const l of String(settings.nyPaths || '').split(/[\n,，;；]+/).map(x => x.trim()).filter(Boolean)) {
                if (!paths.includes(l)) paths.push(l);
            }
        }
        if (!paths.length) return '';
        const presenceNames = findPresenceNames(root);
        const budget = clampNum(settings.varMaxChars, 200, 20000, 3500);
        const sections = [];
        let total = 0;
        for (const p of paths) {
            let val = readVarPath(root, p);
            if (val === undefined || val === null) continue;
            const filtered = filterObjectByNames(val, presenceNames);
            if (filtered) val = filtered;
            const text = typeof val === 'string' ? val.trim() : JSON.stringify(val);
            if (!text || text === '{}' || text === '[]') continue;
            const remain = budget - total;
            if (remain <= 100) break;
            sections.push(`【${p}】\n${text.slice(0, Math.max(300, remain))}`);
            total += Math.min(text.length, remain) + 2;
        }
        if (!sections.length) return '';
        log(`聊天变量检取:${sections.length}段`);
        return sections.join('\n\n');
    } catch (e) { warnLog('聊天变量检取失败', e); return ''; }
}

async function collectCardLore() {
    try {
        if (!settings.cardLorePickup) return '';
        const ctx = parentCtx();
        const chid = ctx?.characterId;
        const character = chid != null ? ctx.characters?.[chid] : null;
        const book = character?.data?.character_book;
        if (!book?.entries?.length) return '';
        const ctx2 = parentCtx();
        const chat = ctx2?.chat || [];
        const scanParts = [];
        for (let i = Math.max(0, chat.length - 3); i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            scanParts.push(String(m.mes || ''));
        }
        const scanRaw = scanParts.join('\n');
        const scanText = scanRaw.toLowerCase();
        if (!scanText) return '';
        const budget = clampNum(settings.loreMaxChars, 500, 20000, 3000);
        const picked = [];
        let total = 0;
        const entries = [...book.entries].sort((a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100));
        for (const e of entries) {
            if (e.enabled === false) continue;
            const content = String(e.content || '').trim();
            if (!content) continue;
            const keys = (Array.isArray(e.keys) ? e.keys : []).map(k => String(k)).filter(Boolean);
            const isConstant = !!e.constant;
            let hit = isConstant;
            if (!hit) {
                for (const k of keys) {
                    const needle = e.caseSensitive ? k : k.toLowerCase();
                    const hay = e.caseSensitive ? scanRaw : scanText;
                    if (!needle) continue;
                    if (e.matchWholeWords && /^[\w\s-]+$/.test(needle)) {
                        if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, e.caseSensitive ? '' : 'i').test(scanRaw)) { hit = true; break; }
                    } else if (hay.includes(needle)) { hit = true; break; }
                }
            }
            if (!hit) continue;
            const title = String(e.comment || keys[0] || '设定').slice(0, 30);
            const block = `◆ ${title}\n${content}`;
            if (total + block.length > budget) continue;
            picked.push(block);
            total += block.length + 2;
        }
        if (!picked.length) return '';
        log(`角色卡世界书检取:${picked.length}条（${total}字）`);
        return picked.join('\n\n');
    } catch (e) { warnLog('角色卡世界书检取失败', e); return ''; }
}

// ===================== 副API（独立连接直连 → generateRaw 兜底） =====================

async function callSubApi(prompt) {
    const url = String(settings.subApiUrl || '').trim().replace(/\/+$/, '');
    const model = String(settings.subApiModel || '').trim();
    const key = String(settings.subApiKey || '').trim();
    const messages = [
        { role: 'system', content: '你是「心相引擎」的判定核心，只输出JSON，不输出任何其他内容。' },
        { role: 'user', content: prompt },
    ];
    if (url && model) {
        try {
            const res = await fetch(url.replace(/\/chat\/completions\/?$/i, '') + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) },
                body: JSON.stringify({ model, messages, temperature: clampNum(settings.subTemperature, 0, 2, 0.7), stream: false }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const msg = data?.choices?.[0]?.message || {};
            const content = String(msg.content || '').trim() || String(msg.reasoning_content || '').trim();
            if (content) { log('判定通道：独立副API·直连 ✓'); return content; }
        } catch (e) { warnLog('独立副API直连失败，回退 generateRaw', e); }
    }
    log('判定通道：generateRaw（跟随当前预设）');
    return await generateRaw({
        ordered_prompts: messages,
        should_silence: true,
    });
}

// ===================== 判定卷子 =====================

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
- 负向砝码（brakes）：为每个岔路口角色申报推向"不做"的现场变量，与增益完全对称——至多2项、每项≤10、须引用现场事实、同一理由禁复用。没有则空数组。天平两侧都要如实称量，不得只报一侧。
- 被动铺垫：本回合若发生了动摇某角色防线的小事件（目睹赴险/被无条件信任/破防瞬间没绷住——TA本人不必在岔路口），写入 passiveForeshadow：至多2项、每项一个角色+具体事件；没有则空数组。
- 临时状态：若某角色带有将持续数楼的情绪/状态，写入 tempState（tag一词+note一句+floors持续楼数1~10）；没有则null。
- 惯性微扰动：无论如何都要准备 microDeviation——从在场角色（优先有档案者）选一个，给出一个基于其当前档位惯性的"微小越轨"，必须微小到不改变剧情走向。
- 阈值公式（最终以系统复核为准）：阈值 = {{baseThreshold}} − 铺垫×{{foreshadowPenalty}} − (档序−1)×{{tierPenalty}} − 增益合计 + 阻力合计，钳制20~90。
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

function buildStoreBlock(st) {
    const names = Object.keys(st.characters);
    if (!names.length) return '（空——本回合需要为在场重点角色建档：isNew=true）';
    return names.map((name) => {
        const ch = st.characters[name];
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
    }).join('\n');
}

function buildSubPrompt(story, st, dice) {
    const vars = {
        storeBlock: buildStoreBlock(st),
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
        maxChars: clampNum(settings.maxCharsPerFloor, 1, 3, 2),
    };
    let prompt = String(settings.customPromptTemplate || '').trim() || BUILTIN_SUB_PROMPT;
    prompt = prompt.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
    const extra = String(settings.extraInstructions || '').trim();
    if (extra) prompt += `\n\n【用户附加要求（优先级高于模板默认规则）】\n${extra}`;
    return prompt;
}

// ===================== 预设建档（聊天绑定世界书「心相·建档·角色名」） =====================

function parseProfileTemplate(content) {
    const text = String(content || '');
    const axisLine = text.match(/轴[:：]\s*(.+)/);
    const tiersLine = text.match(/档位[:：]\s*(.+)/);
    const anchorLine = text.match(/心锚[:：]\s*(.+)/);
    if (!axisLine && !tiersLine) return null;
    const tiers = tiersLine ? tiersLine[1].split(/[|｜]/).map(s => s.trim()).filter(Boolean).slice(0, 4) : [];
    if (tiers.length < 2) tiers.push('动摇', '跨线');
    let anchor = anchorLine ? anchorLine[1].trim() : '';
    const q = anchor.match(/^["“](.*)["”]$/);
    if (q) anchor = q[1];
    return { axis: { name: (axisLine ? axisLine[1].trim() : '性格轴').slice(0, 12), tiers }, anchor: anchor.slice(0, 60) };
}

async function fetchProfileTemplates() {
    const templates = {};
    try {
        const bookName = getChatWorldbookName('current');
        if (bookName) {
            const entries = await getWorldbook(bookName);
            for (const e of entries) {
                if (!e.enabled) continue;
                const cname = String(e.name || e.comment || '');
                if (!cname.startsWith('心相·建档·')) continue;
                const name = cname.slice('心相·建档·'.length).trim();
                const profile = parseProfileTemplate(e.content);
                if (name && profile) templates[name] = profile;
            }
        }
    } catch (e) { warnLog('读取预设建档失败', e); }
    return templates;
}

// ===================== 判定复核与定稿 =====================

function finalizeVerdict(parsed, st, dice) {
    const rawChars = Array.isArray(parsed.characters) ? parsed.characters : [];
    const characters = [];
    for (const raw of rawChars.slice(0, clampNum(settings.maxCharsPerFloor, 1, 3, 2))) {
        const name = String(raw?.name || '').trim();
        if (!name) continue;
        const known = st.characters[name];
        const isNew = !known;
        let axis = known ? known.axes[0] : normalizeAxis(raw?.axis);
        let anchor = known?.anchor || String(raw?.anchor || '');
        const foreshadow = isNew ? 0 : (known.foreshadow || 0);
        const tier = axis.tier || 1;
        const recentReasons = (known?.recentGains || []).map(g => g.reason);
        const recentBrakeReasons = (known?.recentBrakes || []).map(g => g.reason);
        const gains = clampGain(raw?.gains, recentReasons);
        const brakes = clampGain(raw?.brakes, recentBrakeReasons);
        const { formulaText, threshold, isClamped } = computeThreshold(foreshadow, tier, gains, brakes);
        const segment = computeSegment(dice.move, threshold);
        const crossroadText = [raw?.crossroad?.do, raw?.crossroad?.not].map(s => String(s || '').trim()).filter(Boolean).join(' ⇄ ');
        characters.push({
            name, isNew,
            axis: { name: axis.name, tiers: axis.tiers.slice(), tier },
            anchor: String(anchor).slice(0, 40),
            block: String(known?.block || '').slice(0, 20),
            temp: known?.temp ? { ...known.temp } : null,
            crossroad: { do: String(raw?.crossroad?.do || '').slice(0, 40), not: String(raw?.crossroad?.not || '').slice(0, 40) },
            crossroadText: crossroadText.slice(0, 80),
            relState: String(raw?.relState || '').slice(0, 80),
            emoState: String(raw?.emoState || '').slice(0, 80),
            gains, brakes, foreshadow,
            dice: dice.move, formulaText, isClamped, threshold, segment,
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
    const noCrossroad = !!parsed.noCrossroad || characters.length === 0;
    let microTriggered = null;
    const microRaw = parsed.microDeviation && parsed.microDeviation.name ? {
        name: String(parsed.microDeviation.name).slice(0, 12),
        action: String(parsed.microDeviation.action || '').slice(0, 80),
    } : null;
    if (noCrossroad && microRaw?.action) {
        const chance = clampNum(settings.microDeviationChance, 0, 50, 5);
        if (chance > 0 && roll100() <= chance) microTriggered = microRaw;
    }
    const passive = (Array.isArray(parsed.passiveForeshadow) ? parsed.passiveForeshadow : []).slice(0, 2)
        .map(p => ({ name: String(p?.name || '').slice(0, 12), reason: String(p?.reason || '').slice(0, 60) }))
        .filter(p => p.name && p.reason);
    const ts = parsed.tempState && parsed.tempState.name ? {
        name: String(parsed.tempState.name).slice(0, 12),
        tag: String(parsed.tempState.tag || '波动').slice(0, 8),
        note: String(parsed.tempState.note || '').slice(0, 40),
        floors: clampNum(parsed.tempState.floors, 1, 10, 3),
    } : null;
    return {
        dice, noCrossroad,
        subtext: String(parsed.subtext || '').slice(0, 100),
        characters, passive, tempState: ts, micro: microRaw, microTriggered,
        world: parsed.world ? { dice: dice.world, event: String(parsed.world).slice(0, 80) } : null,
    };
}

// ===================== 落账 =====================

function rollbackMesid(mesid) {
    const acc = store.accountsByMesid?.[mesid];
    if (!acc?.undo) return;
    for (const [name, prev] of Object.entries(acc.undo)) {
        if (prev === null) delete store.characters[name];
        else store.characters[name] = prev;
    }
    delete store.accountsByMesid[mesid];
    saveStore();
    log(`已回滚楼层#${mesid}的旧账目（swipe幂等）`);
}

function commitVerdict(verdict) {
    const mesid = Math.max(0, (parentCtx()?.chat?.length || 1) - 1);
    const touched = new Set([...verdict.characters.map(c => c.name), ...verdict.passive.map(p => p.name)]);
    if (verdict.tempState) touched.add(verdict.tempState.name);
    const undo = {};
    for (const name of touched) {
        undo[name] = store.characters[name] ? JSON.parse(JSON.stringify(store.characters[name])) : null;
    }
    for (const f of verdict.characters) {
        const ch = ensureCharacter(f.name);
        const ax = ch.axes[0];
        if (f.segment === '坚定') ax.tier = Math.min(ax.tiers.length, (ax.tier || 1) + 1);
        if (['不做', '其它', '应激崩溃'].includes(f.segment)) ch.foreshadow = (ch.foreshadow || 0) + 1;
        if (f.segment === '应激崩溃' && f.blockNote) ch.block = f.blockNote;
        ch.lastMove = f.move;
        if (f.ding) ch.lastDing = f.ding;
        if (!ch.anchor && f.anchor) ch.anchor = f.anchor;
        ch.history.unshift({
            ts: Date.now(), mesid,
            dice: f.dice, threshold: f.threshold, segment: f.segment, move: f.move,
            formulaText: f.formulaText, gains: f.gains, brakes: f.brakes, crossroad: f.crossroadText,
            relState: f.relState, emoState: f.emoState,
            ding: f.ding, afterglow: f.afterglow, thirdWay: f.thirdWay,
        });
        ch.history = ch.history.slice(0, 30);
        ch.recentMaterial.unshift({ ding: f.ding, forceNot: f.forceNot, forceDo: f.forceDo, memory: f.memory });
        ch.recentMaterial = ch.recentMaterial.slice(0, 2);
        for (const g of f.gains) ch.recentGains.unshift({ reason: g.reason });
        ch.recentGains = ch.recentGains.slice(0, 6);
        for (const b of f.brakes) ch.recentBrakes.unshift({ reason: b.reason });
        ch.recentBrakes = ch.recentBrakes.slice(0, 6);
        store.characters[f.name] = ch;
    }
    for (const p of verdict.passive) {
        const ch = ensureCharacter(p.name);
        ch.foreshadow = (ch.foreshadow || 0) + 1;
        store.characters[p.name] = ch;
    }
    for (const ch of Object.values(store.characters)) {
        if (ch.temp) { ch.temp.floorsLeft -= 1; if (ch.temp.floorsLeft <= 0) ch.temp = null; }
    }
    if (verdict.tempState) {
        const ch = ensureCharacter(verdict.tempState.name);
        ch.temp = { tag: verdict.tempState.tag, note: verdict.tempState.note, floorsLeft: verdict.tempState.floors };
        store.characters[verdict.tempState.name] = ch;
    }
    if (verdict.noCrossroad) {
        store.streakNoCrossroad = (store.streakNoCrossroad || 0) + 1;
        if (store.streakNoCrossroad >= 5 && !store.streakWarned) {
            store.streakWarned = true;
            try { toastr.warning(`已连续 ${store.streakNoCrossroad} 楼无岔路口——角色可能正在回归惯性演出`, '心相引擎'); } catch { }
        }
    } else { store.streakNoCrossroad = 0; store.streakWarned = false; }

    store.accountsByMesid[mesid] = { ts: Date.now(), characters: verdict.characters, world: verdict.world, undo, micro: verdict.microTriggered, passive: verdict.passive, subtext: verdict.subtext };
    const keys = Object.keys(store.accountsByMesid).map(Number).sort((a, b) => a - b);
    while (keys.length > 50) delete store.accountsByMesid[keys.shift()];
    store.log.unshift({
        ts: Date.now(), mesid,
        summary: verdict.noCrossroad ? `无岔路口${verdict.microTriggered ? `｜微扰动:${verdict.microTriggered.name}` : ''}（骰${verdict.dice.move}）` : verdict.characters.map(c => `${c.name}:骰${c.dice}/阈${c.threshold}/${c.segment}`).join('；'),
        world: verdict.world?.event || '',
    });
    store.log = store.log.slice(0, 30);
    saveStore();
    renderVerdictBadge(mesid);
    if ($('#heart_panel_th').length) renderConsole();
    if (settings.worldBookSync) {
        syncExperienceEntries([...touched]).catch(e => warnLog('世界书联动失败', e));
    }
}

// ===================== 世界书联动（聊天绑定书） =====================

function buildExperienceContent(name, ch) {
    const ax = ch.axes?.[0] || {};
    const tierName = ax.tiers?.[(ax.tier || 1) - 1] || '?';
    const lines = [`【心相引擎·角色档案】${name}`];
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
    const bookName = await getOrCreateChatWorldbook('current', `心相引擎·${(SillyTavern.getContext().chatId || 'chat')}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90));
    if (!bookName) return;
    const entries = await getWorldbook(bookName);
    let changed = false;
    for (const name of names) {
        const ch = store.characters[name];
        if (!ch) continue;
        const wantName = `心相·经历·${name}`;
        let entry = entries.find(e => String(e.name || e.comment || '') === wantName);
        if (!entry) {
            entry = {
                uid: entries.length ? Math.max(...entries.map(e => e.uid ?? 0)) + 1 : 0,
                name: wantName, enabled: true,
                strategy: { type: 'selective', keys: [name], secondary_keys: [], logic: 'and_any' },
                insertion_order: 100, position: 'after_char', content: '', constant: false,
            };
            entries.push(entry);
            changed = true;
        }
        const content = buildExperienceContent(name, ch);
        if (entry.content !== content) { entry.content = content; changed = true; }
        if (JSON.stringify(entry.strategy?.keys) !== JSON.stringify([name])) { entry.strategy.keys = [name]; changed = true; }
    }
    if (!changed) return;
    await replaceWorldbook(bookName, entries);
    log(`世界书《${bookName}》已更新（${names.join('、')}）`);
}

// ===================== 注入与徽章 =====================

let pendingVerdict = null;
const AUTO_TYPES = new Set(['normal', 'swipe', 'regenerate']);

function buildInjection(v) {
    const lines = [];
    lines.push('［心相引擎·本回合判定（已由插件机械结算：以下骰值、阈值、区段与行为裁决必须原样采信，禁止改判、重掷或自行补算）］');
    if (v.subtext) lines.push(`▎用户行为解读(潜台词):${v.subtext}——正文与反应请与该解读一致`);
    if (v.noCrossroad) {
        lines.push('▎本回合无角色处于岔路口：全员按各自当前档位与惯性行动，禁止强行制造抉择、顿悟与突破。');
    } else {
        for (const f of v.characters) {
            const tierName = f.axis.tiers[(f.axis.tier || 1) - 1] || '?';
            const gainsText = f.gains.length ? f.gains.map(g => `${g.reason}+${g.value}`).join('；') : '无';
            const brakesText = f.brakes.length ? f.brakes.map(b => `${b.reason}+${b.value}`).join('；') : '';
            lines.push(`▎${f.name}｜${f.axis.name}:${tierName}(档序${f.axis.tier})｜铺垫:${f.foreshadow}${f.isNew ? '（本回合新建档）' : ''}${f.block && f.block !== '—' ? `｜心结:${f.block}` : ''}${f.anchor ? `｜心锚:"${f.anchor}"` : ''}${f.temp ? `｜临时状态:${f.temp.tag}(${f.temp.note})` : ''}`);
            lines.push(`  认知:关系=${f.relState || '—'}｜情绪=${f.emoState || '—'}——砝码与正文必须与此认知自洽`);
            lines.push(`  落子骰:${f.dice}(系统真随机)｜正向砝码:${gainsText}${brakesText ? `｜负向砝码:${brakesText}` : ''}｜算式:${f.formulaText}${f.isClamped ? `（钳制后阈值${f.threshold}）` : ''}｜区段:${f.segment}`);
            lines.push(`  行为裁决:${(SEGMENT_RULING[f.segment] || '').replace('{thirdWay}', f.thirdWay || '（无）')}`);
            lines.push(`  岔路口:"做"＝${f.crossroad.do} ⇄ "不做"＝${f.crossroad.not}`);
            lines.push(`  推演素材（化进正文，禁止照抄为账目）:不做的力量:${f.forceNot || '—'}／去做的力量:${f.forceDo || '—'}／记忆浮现:${f.memory || '—'}／定音:${f.ding || '—'}／余韵:${f.afterglow || '—'}`);
        }
        lines.push('▎其余角色:无岔路口，按各自档位惯性一段带过，不做全量心相分析。');
    }
    if (v.passive.length) lines.push(`▎幕后变化（防线被动摇，铺垫已+1）:${v.passive.map(p => `${p.name}——${p.reason}`).join('；')}。以细节体现在正文里`);
    if (v.microTriggered) lines.push(`▎惯性微扰动（低概率随机事件，已触发）:${v.microTriggered.name}——${v.microTriggered.action}。以不经意的细节融入正文，禁止写成重大转折或角色突变`);
    if (settings.worldDice && v.dice.world != null) lines.push(`▎世界无常:世界骰${v.dice.world}——${v.world?.event || '无与人无关的偶然事件'}（原样结算，禁止扭曲）`);
    lines.push('▎铁律:①以上账目与行为裁决不可改动、不可迎合用户改写 ②正文禁止出现骰值/阈值/账目字样，只呈现结果与挣扎的痕迹 ③本回合无需你掷骰、无需输出判定思考、无需复制或维护状态快照 ④定音必须换新，禁止复读上一楼的理由。');
    return lines.join('\n');
}

function renderVerdictBadge(mesid) {
    try {
        if (!settings.showFloorBadge) return;
        mesid = Number(mesid);
        if (!Number.isFinite(mesid) || mesid < 0) return;
        const pdoc = window.parent?.document;
        if (!pdoc) return;
        const mes = pdoc.querySelector(`#chat .mes[mesid="${mesid}"]`);
        if (!mes) return;
        mes.querySelectorAll('.heart-verdict-th').forEach(n => n.remove());
        const acc = store.accountsByMesid?.[mesid];
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
                <div>正向砝码:${escapeHtml(gains)}${brakes ? `｜负向砝码:${escapeHtml(brakes)}` : ''}｜算式:${escapeHtml(String(c.formulaText ?? ''))}</div>
                ${c.thirdWay ? `<div>第三条路:${escapeHtml(c.thirdWay)}</div>` : ''}
                ${c.ding ? `<div>定音:${escapeHtml(c.ding)}</div>` : ''}
                ${c.afterglow ? `<div>余韵:${escapeHtml(c.afterglow)}</div>` : ''}
            </div>`);
        }
        if (acc.micro) parts.push(`<div class="heart-verdict-char"><div>惯性微扰动:${escapeHtml(acc.micro.name)}——${escapeHtml(acc.micro.action)}</div></div>`);
        if (acc.world?.event) parts.push(`<div class="heart-verdict-char"><div>世界骰 ${acc.world.dice}：${escapeHtml(acc.world.event)}</div></div>`);
        const summaryText = chars.length ? chars.map(c => `${c.name}→${c.move}`).join('；') : (acc.micro ? '微扰动' : '世界骰');
        const wrap = pdoc.createElement('div');
        wrap.innerHTML = `<details class="heart-verdict-th"><summary>🎲 心相判定（${escapeHtml(summaryText)}）</summary>${parts.join('')}</details>`;
        mes.querySelector('.mes_text')?.after(wrap.firstChild);
    } catch (e) { warnLog('徽章渲染失败', e); }
}

// ===================== 浮动控制台（精简版：档案/记录） =====================

function bindDrag(handle, target, posKey) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('input,textarea,select,button,a,.heart-tab,.heart-panel-body')) return;
        e.preventDefault();
        let dragged = false;
        const sx = e.clientX, sy = e.clientY;
        const rect = target.getBoundingClientRect();
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!dragged && Math.abs(dx) + Math.abs(dy) < 6) return;
            dragged = true;
            const x = Math.max(0, Math.min(window.innerWidth - 60, rect.left + dx));
            const y = Math.max(0, Math.min(window.innerHeight - 40, rect.top + dy));
            target.style.left = x + 'px'; target.style.top = y + 'px';
        };
        const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            if (dragged) {
                const r = target.getBoundingClientRect();
                settings[posKey] = { x: Math.round(r.left), y: Math.round(r.top) };
                saveSettings();
            }
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
    });
}

function renderConsole() {
    let root = document.getElementById('heart_panel_th');
    if (!root) {
        root = document.createElement('div');
        root.id = 'heart_panel_th';
        document.body.appendChild(root);
    }
    const streak = store.streakNoCrossroad || 0;
    const cards = Object.keys(store.characters).map((name) => {
        const ch = store.characters[name];
        const ax = ch.axes?.[0] || {};
        const tierName = ax.tiers?.[(ax.tier || 1) - 1] || '?';
        const hist = (ch.history || []).slice(0, 10).map(h => {
            const t = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            return `<div class="hh-row"><div>[${escapeHtml(t)} #${h.mesid}] 骰${h.dice} vs 阈${h.threshold} → <b>${escapeHtml(h.move)}</b>（${escapeHtml(h.segment)}）</div>${h.relState ? `<div class="hh-sub">认知:关系=${escapeHtml(h.relState)}</div>` : ''}${h.ding ? `<div class="hh-sub">定音:${escapeHtml(h.ding)}</div>` : ''}</div>`;
        }).join('') || '<div class="hh-sub">（暂无判定记录）</div>';
        return `<div class="hh-char"><div class="hh-name">${escapeHtml(name)}</div>
            <div class="hh-sub">${escapeHtml(ax.name || '?')}:${escapeHtml(tierName)}(档序${ax.tier || 1})｜铺垫:${ch.foreshadow || 0}｜心结:${escapeHtml(ch.block || '—')}</div>
            ${ch.anchor ? `<div class="hh-sub">心锚:"${escapeHtml(ch.anchor)}"</div>` : ''}
            <details open><summary>判定记录</summary>${hist}</details></div>`;
    }).join('') || '<div class="hh-sub">当前聊天还没有角色档案（判定一次后自动建档）</div>';
    const logs = (store.log || []).slice(0, 15).map(e => {
        const t = new Date(e.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        return `<div class="hh-row">[${escapeHtml(t)} #${e.mesid}] ${escapeHtml(e.summary)}${e.world ? `<div class="hh-sub">世界:${escapeHtml(e.world)}</div>` : ''}</div>`;
    }).join('');
    const allDice = [];
    for (const acc of Object.values(store.accountsByMesid || {})) for (const c of (acc.characters || [])) if (Number.isFinite(c.dice)) allDice.push(c.dice);
    const stats = allDice.length ? `骰值统计:${allDice.length}次｜均值${(allDice.reduce((a, b) => a + b, 0) / allDice.length).toFixed(1)}（期望50.5）` : '尚无骰值数据';

    root.innerHTML = `
    <div class="hh-head" id="hh_head"><span>🎲 心相引擎 <small>${streak >= 5 ? `⚠连续无岔路口:${streak}楼` : ''}</small></span><span id="hh_close" style="cursor:pointer">✕</span></div>
    <div class="hh-body">
      <div class="hh-sec">角色档案</div>${cards}
      <div class="hh-sec">记录与统计</div><div class="hh-sub">${escapeHtml(stats)}</div>${logs || '<div class="hh-sub">（尚无判定记录）</div>'}
      <div class="hh-sec">快捷操作</div>
      <div class="hh-row">
        <button id="hh_btn_reset">重置本聊天存档</button>
        <button id="hh_btn_${settings.autoMode ? 'off' : 'on'}">自动判定:${settings.autoMode ? '开' : '关'}</button>
      </div>
    </div>`;
    document.getElementById('hh_close').onclick = () => root.remove();
    document.getElementById('hh_btn_reset').onclick = () => { if (confirm('重置本聊天心相存档？')) resetStore(); };
    const btnAuto = root.querySelector('[id^="hh_btn_on"], [id^="hh_btn_off"]');
    if (btnAuto) btnAuto.onclick = async () => { settings.autoMode = !settings.autoMode; await saveSettings(); renderConsole(); };
    bindDrag(document.getElementById('hh_head'), root, 'panelPos');
    const pos = settings.panelPos;
    if (pos) { root.style.left = pos.x + 'px'; root.style.top = pos.y + 'px'; }
}

function ensureFloatingUI() {
    if (document.getElementById('heart_fab_th')) return;
    const fab = document.createElement('div');
    fab.id = 'heart_fab_th';
    fab.title = '心相引擎（拖动移动/点击打开）';
    fab.textContent = '🎲';
    document.body.appendChild(fab);
    const pos = settings.fabPos;
    if (pos) { fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px'; }
    bindDrag(fab, fab, 'fabPos');
    fab.addEventListener('click', (e) => {
        if (fab.dataset.dragged === '1') { fab.dataset.dragged = '0'; return; }
        const p = document.getElementById('heart_panel_th');
        if (p) p.remove(); else renderConsole();
    });
}

// ===================== 判定主流程 =====================

async function runVerdict() {
    const ctx = parentCtx();
    const chat = ctx?.chat || [];
    if (!chat.length) return null;
    const lastMsg = chat[chat.length - 1];
    const targetMesid = lastMsg?.is_user ? chat.length : chat.length - 1;
    rollbackMesid(targetMesid);

    loadStore();
    const story = await collectStoryContext();
    const nDice = clampNum(settings.diceSampleCount, 1, 20, 10);
    const dice = { move: rollDice(nDice), world: settings.worldDice ? rollDice(nDice) : null };
    log(`开始判定｜落子骰${dice.move}${nDice > 1 ? `(${nDice}次均值)` : ''}${dice.world != null ? `｜世界骰${dice.world}` : ''}｜柏宝书:${story.source === 'baibaibook' ? '已连接' : '未连接(本地降级)'}`);

    const prompt = buildSubPrompt(story, store, dice);
    let parsed = null, lastErr = null, lastRaw = '';
    for (let attempt = 0; attempt < (settings.strictRetry ? 2 : 1); attempt++) {
        try {
            const usePrompt = attempt === 0 ? prompt : `${prompt}\n\n【重试！你上一次的输出无法解析为JSON】上次开头："${String(lastRaw || '').slice(0, 120).replace(/\s+/g, ' ')}"。这次直接输出JSON对象本体，从{到}，禁止思考块/markdown/解释。`;
            const raw = await callSubApi(usePrompt);
            lastRaw = raw;
            let t = String(raw || '').trim();
            const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) t = fence[1].trim();
            const start = t.indexOf('{'), end = t.lastIndexOf('}');
            if (start < 0 || end <= start) throw new Error('未找到JSON对象');
            parsed = JSON.parse(t.slice(start, end + 1));
            break;
        } catch (e) { lastErr = e; warnLog(`副API返回无效（第${attempt + 1}次）`, e); }
    }
    if (!parsed) {
        try { toastr.error(`副API判定失败：${lastErr?.message || '未知错误'}`, '心相引擎'); } catch { }
        return null;
    }
    const verdict = finalizeVerdict(parsed, store, dice);
    // "其它"无第三条路 → 降级"不做"
    for (const f of verdict.characters) {
        if (f.segment === '其它' && !f.thirdWay) { f.segment = '不做'; f.move = '不做'; }
    }
    log('判定完成｜' + (verdict.noCrossroad ? `无岔路口${verdict.microTriggered ? `｜微扰动:${verdict.microTriggered.name}` : ''}` : verdict.characters.map(c => `${c.name} 骰${c.dice}/阈${c.threshold}/${c.segment}`).join('；')));
    return verdict;
}

async function onGenerationAfterCommands(type, options, dryRun) {
    try {
        if (dryRun === true) return;
        if (!settings.enabled || !settings.autoMode) return;
        if (!AUTO_TYPES.has(String(type))) return;
        const ctx = parentCtx();
        const chat = ctx?.chat || [];
        const lastMsgNow = chat[chat.length - 1];
        if (!lastMsgNow?.is_user && String(type) === 'normal') {
            const targetMesid = chat.length - 1;
            const recentAcc = store.accountsByMesid?.[targetMesid];
            if (recentAcc && (Date.now() - recentAcc.ts) < 90 * 1000) {
                log(`跳过判定：楼层#${targetMesid}为本回合框架二次生成（如MVU变量更新），不重掷骰子`);
                return;
            }
        }
        const verdict = await runVerdict();
        if (verdict) {
            pendingVerdict = verdict;
            injectPrompts([{
                id: INJECT_ID, position: 'in_chat', depth: 4, role: 'system',
                content: buildInjection(verdict),
            }], { once: true });
        }
    } catch (e) {
        console.error(LOG, '判定流程异常，本回合降级为无判定', e);
        try { toastr.warning('心相引擎判定异常，本回合已降级为无判定', '心相引擎'); } catch { }
    }
}

function onGenerationEnded() {
    try {
        if (!pendingVerdict) return;
        const chat = parentCtx()?.chat || [];
        const mesid = chat.length - 1;
        if (mesid >= 0 && chat[mesid] && !chat[mesid].is_user) commitVerdict(pendingVerdict);
    } catch (e) { warnLog('落账失败', e); } finally { pendingVerdict = null; }
}

// ===================== 样式与初始化 =====================

function injectStyles(targetDoc) {
    if (targetDoc.getElementById('heart_th_styles')) return;
    const style = targetDoc.createElement('style');
    style.id = 'heart_th_styles';
    style.textContent = `
#heart_fab_th{position:fixed;z-index:9998;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:grab;user-select:none;touch-action:none;background:rgba(20,20,26,.92);border:1px solid rgba(128,128,128,.4);box-shadow:0 2px 10px rgba(0,0,0,.4);opacity:.85;right:18px;bottom:120px}
#heart_fab_th:hover{opacity:1}
#heart_panel_th{position:fixed;z-index:9999;width:min(520px,94vw);max-height:78vh;overflow-y:auto;background:rgba(20,20,26,.97);color:#ddd;border:1px solid rgba(128,128,128,.4);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-size:.85rem;line-height:1.5;padding:10px 12px}
.hh-head{display:flex;justify-content:space-between;font-weight:700;font-size:.95rem;margin-bottom:6px;cursor:grab}
.hh-sec{font-weight:700;margin:8px 0 4px;padding-bottom:3px;border-bottom:1px solid rgba(128,128,128,.3)}
.hh-char{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:6px 8px;margin:6px 0}
.hh-name{font-weight:700}
.hh-sub{opacity:.8;font-size:.78rem;margin:2px 0;white-space:pre-wrap}
.hh-row{border-top:1px dashed rgba(128,128,128,.2);padding:3px 0;margin-top:3px;font-size:.8rem}
.hh-row button{margin-right:8px;padding:2px 10px;cursor:pointer}
#chat .heart-verdict-th{margin:6px 0 2px;font-size:.78rem;line-height:1.5;opacity:.9;background:rgba(128,128,128,.12);border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:4px 10px;max-width:640px}
#chat .heart-verdict-th summary{cursor:pointer;font-weight:600}
#chat .heart-verdict-char{margin:4px 0;padding-top:4px;border-top:1px dashed rgba(128,128,128,.2)}`;
    targetDoc.head.appendChild(style);
}

async function main() {
    // 与扩展版互斥检测：若酒馆扩展版已加载（设置抽屉存在），默认休眠
    try {
        if (window.parent?.document?.getElementById('heart_engine_settings')) {
            warnLog('检测到同名扩展版已在运行，脚本进入休眠（请二选一启用）');
            return;
        }
    } catch { /* 父窗口访问受限则继续 */ }

    await loadSettings();
    loadStore();
    injectStyles(document);
    ensureFloatingUI();

    eventOn(tavern_events.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventOn(tavern_events.GENERATION_ENDED, onGenerationEnded);
    eventOn(tavern_events.CHAT_CHANGED, () => { pendingVerdict = null; loadStore(); });
    eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, (mesid) => renderVerdictBadge(mesid));
    eventOn(tavern_events.MESSAGE_UPDATED, (mesid) => renderVerdictBadge(mesid));

    log('已加载：骰子本地掷、算式本地算、副API单次推演、存档随聊天变量、世界书联动');
}

main();
