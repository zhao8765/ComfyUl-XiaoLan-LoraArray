// =============================================================================
//  小岚 lora 阵列 —— 前端界面  v7.4
//
//  两个节点：
//    1) 小岚lora阵列        XiaoLanLoraArray        —— 纯 LoRA 阵列
//    2) 小岚lora阵列 + 提示词 XiaoLanLoraArrayPrompt —— 同上，另加多行提示词框 + 文本列表 + 文本输入/输出
//
//  顶部一行： [ 总开关 ] [ ＋ 添加 LoRA ] [ ＋ 添加文本 ]
//    · 添加按钮放在顶部而不是节点底部 —— 底部的话每加一行它就往下跑，
//      点完还得追着鼠标找它；固定在顶部就不用挪鼠标。
//    · 三个盒子各有各的热区，命中判定严格按 x 落在盒内、y 落在这一行内，
//      落在缝隙里什么都不做 —— 即"按钮只在框中生效"，不会串台。
//    · 「＋ 添加文本」只有提示词版节点才有（文本列表只在它这里参与输出）。
//
//  每行布局（从左往右）： [ 开关 ] [ ◀ LoRA 名称 ▶ ] [ − 权重 + ] [ 触发词 ] [ ✕ ]
//    · 开关（最左）     → 单独启用/停用这一行；停用后该行不加 LoRA、不输出触发词
//    · 点 LoRA 胶囊中间 → 弹出列表直接选（无需输入文字，同原生 combo）
//    · 胶囊左右箭头     → 上一个 / 下一个 LoRA
//    · 权重区 +/−       → 每次 ±0.05；按住左右拖动可微调 0.01/步
//    · 点触发词区       → 弹出输入框
//    · 行尾 ✕           → 删除该行，下方行整体上移
//  行数不限（超过 30 行时多出一行灰色说明）
//
//  文本列表（仅提示词版）在 LoRA 行区下方：
//    · 说明行： "文本列表 · N 条（标题仅备注，不参与输出）" + 右侧「✕ 删除末条」
//    · 每行： [ 开关 ] [ 标题/备注（虚线框，不输出） ] [ 正文 ] [ ✕ ]
//    · 条数不限（上限 MAX_TEXTS），为空时整个区块不占高度
//
//  提示词版节点在文本列表下方另有：
//    · 一行说明文字，左右两端分别是【文本输入】端口 与【文本输出】端口
//    · 一个多行提示词框（直接复用前端原生 DOM textarea，可换行、可滚动）
//    · 提示词框右侧的只读「最终文本预览」（画在画布上）
//    · 两者中间有一条**可拖动的分隔条**：按住左右拖 = 调两个框的宽度比，
//      双击 = 恢复默认 58%。比例存在 node.properties.xiaolanPromptSplit 里，
//      跟着工作流一起存，不占 widgets_values（否则又得给控件值回填加分支）。
//
//  输出：
//    · 小岚lora阵列        → model / 触发词合并输出 / 触发词1…触发词30
//    · 提示词版            → model / 文本触发词合并输出 / 触发词1…触发词30 / 文本输出
//                            文本触发词合并输出 = 文本输入 + 提示词框 + 文本列表正文 + 各生效行的触发词
//                            文本输出 = 与它完全相同（只是多一个紧挨提示词框的出口）
//
//  数据流：所有行存在一个隐藏控件 rows_data（JSON 数组）里，后端只读它；
//          文本列表同理存在 texts_data（JSON 数组）里。
//          这样条数才不受 INPUT_TYPES 的固定槽位限制。
//          row_1..row_10 + lora_count 保留仅为迁移旧工作流。
//
//  ⚠ 前端加载时机高度敏感，故做了多路自愈（见下方 register）：
//     1) beforeRegisterNodeDef → onNodeCreated    （标准路径）
//     2) loadedGraphNode                          （打开工作流时）
//     3) setup() 扫描已存在节点                    （扩展晚于工作流加载）
//     4) onDrawForeground 里惰性升级               （最终兜底，只要有渲染就会升级）
// =============================================================================

import * as appMod from "../../../scripts/app.js";

const VERSION = "v7.4";
const NODE_NAME = "XiaoLanLoraArray";
const PROMPT_NODE_NAME = "XiaoLanLoraArrayPrompt";
const NODE_NAMES = new Set([NODE_NAME, PROMPT_NODE_NAME]);

const LEGACY_SLOTS = 10; // 旧版固定槽位（仅迁移用）
const MAX_OUT = 30; // 独立触发词输出端口数（后端固定）
const MAX_ROWS = 200; // 行数安全上限
const MAX_TEXTS = 50; // 文本列表条数上限（后端 MAX_TEXTS 同值）

const ROW_H = 26;
const ROW_GAP = 4;
const HEADER_H = 24; // 顶部那一行：左「总开关」中「＋ 添加 LoRA」右「＋ 添加文本」
const HEADER_TOGGLE_RATIO = 0.44; // 总开关占可用宽度的比例（剩下的归两个添加按钮）
const HINT_H = 16; // 说明文字行（如"超过 30 行…"，仅在需要时占高度）
const ADD_H = 28; // 兼容旧引用
// 文本列表（仅提示词版节点）
const TEXT_HEADER_H = 20; // "文本列表 · N 条" + 右侧「✕ 删除末条」
const TEXT_BTN_W = 80; // 「✕ 删除末条」按钮宽度（热区也只在这个框里）
const TEXT_TITLE_RATIO = 0.34; // 标题栏占"标题+正文"总宽的比例（标题都很短，正文多分一点）
const TEXT_COLOR = "#c8b6ff"; // 文本列表行的强调色，和 LoRA 行区分开
// 提示词框（仅提示词版节点）—— 前端原生的 DOM textarea，盒子由 ComfyUI 布。
// 实测（frontend 1.42.15）换算关系就一条：
//     textarea 实际高度 = 布局分到的高度 - widget.margin * 2
// （margin 默认 10，见 BaseDOMWidgetImpl.DEFAULT_MARGIN；DomWidgets.vue 里
//   size[1] = computedHeight - margin*2，textarea 用 h-full 填满它。）
// 所以想让它视觉上 PROMPT_BOX_H 高，布局要分到 PROMPT_BOX_H + margin*2。
// 这里 margin 是运行时动态读的（见 upgradeNode），下面只是读不到时的兜底。
const PROMPT_BOX_H = 96; // 没被拉伸时 textarea 的视觉高度
const PROMPT_CHROME_FALLBACK = 20; // margin(10) * 2 的兜底
const PROMPT_H = PROMPT_BOX_H + PROMPT_CHROME_FALLBACK; // 默认起点高度（会被动态值覆盖）

// 提示词框右边的「最终文本预览」——只读，实时显示"文本输入 + 提示词 + 文本列表 + 各行触发词"，
// 省得用户为了确认触发词有没有拼上，还要执行一次、再挂个 Show Text 去看。
// 两个框之间的分栏**可以用鼠标拖动调整**（见 promptSplit / beginSplitDrag）。
const PROMPT_SPLIT = 0.58; // 提示词框占可用宽度的比例（默认值，用户可拖）
const PROMPT_SPLIT_MIN = 0.26; // 拖动的下限
const PROMPT_SPLIT_MAX = 0.78; // 拖动的上限
const SPLIT_HIT = 9; // 分隔条热区半宽（画布像素）
const SPLIT_MIN_BOX = 150; // 提示词框的最小宽度
const SPLIT_GRIP_H = 46; // 分隔条中间那截"抓手"的高度
const PREVIEW_MIN_W = 130; // 预览框比这还窄就不画了（节点太窄时）
const PREVIEW_PAD = 8;
const PREVIEW_TITLE_H = 14;
const PREVIEW_LINE_H = 15;

const NODE_W = 560; // 期望宽度（自适应，窄了会自动压缩元素）
const M = 12;
const GAP = 6;
const SW_W = 30;
const WEIGHT_W = 96;
const WEIGHT_W_MIN = 78;
const TRIG_W = 126;
const TRIG_W_MIN = 84;
const DEL_W = 26;
const RIGHT_RESERVE = 104; // 右侧留给输出端口标签（"触发词合并输出"）
const RIGHT_RESERVE_PROMPT = 140; // "文本触发词合并输出" 更长，右侧要多留一点

const ARROW_W = 20; // 胶囊左右箭头热区
const TOP_Y = 44; // NODE_TITLE_HEIGHT(30) + 14
const HEADER_OUT_Y = [14, 32];
const HEADER_ADD_MIN = 86; // 「＋ 添加 LoRA」最小宽度，再窄就挤掉文字了
const HEADER_TEXT_MIN = 74; // 「＋ 添加文本」最小宽度

const DEFAULT_STATE = { lora: "None", w: 1.0, t: "", e: true };
// 文本列表一条的状态：title 只是备注（不输出），text 才是正文，e 是这一条的开关
const DEFAULT_TEXT = { title: "", text: "", e: true };
// 后端声明、但界面不直接显示的控件（prompt_text 只在提示词版节点里显示，故不在此列）
const DECLARED = new Set([
    "toggle",
    "lora_count",
    "rows_data",
    "texts_data",
    ...Array.from({ length: LEGACY_SLOTS }, (_, i) => `row_${i + 1}`),
]);
// 可序列化控件里"头段"的固定长度：toggle / lora_count / row_1..row_10 / rows_data。
// 新版控件一律追加在头段之后，回填旧工作流时靠这个切分（见 restoreWidgetValues）。
const DECL_HEAD = 2 + LEGACY_SLOTS + 1; // = 13

/** 是否"提示词版"节点 */
const isPromptNode = (node) =>
    !!node && (node.type === PROMPT_NODE_NAME || node.comfyClass === PROMPT_NODE_NAME);

/** 这个节点有没有"文本列表"（只有提示词版有；程序生成的中途态可能还没有 __xiaolan） */
const hasTextList = (node) => isPromptNode(node) && !!node.__xiaolan?.texts;

/** 右侧为端口标签预留的宽度 */
const reserveOf = (node) => (isPromptNode(node) ? RIGHT_RESERVE_PROMPT : RIGHT_RESERVE);

// -----------------------------------------------------------------------------
// 取 app（带兜底：该 shim 在模块求值时就固定了值，时机偏早会拿到 undefined，
// 那时 registerExtension 抛错 → 整个扩展静默失效 → 节点退化成一堆原生文本框）
// -----------------------------------------------------------------------------
function getApp() {
    try {
        return appMod?.app || globalThis.comfyAPI?.app?.app || globalThis.app || null;
    } catch (e) {
        return globalThis.app || null;
    }
}

// -----------------------------------------------------------------------------
// 主题色（带 400ms 缓存，避免每帧 getComputedStyle）
// -----------------------------------------------------------------------------
let _theme = null;
let _themeAt = 0;
function T() {
    const now = Date.now();
    if (_theme && now - _themeAt < 400) return _theme;
    _themeAt = now;
    const g = (k, d) => {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(k).trim();
            return v || d;
        } catch (e) {
            return d;
        }
    };
    const LG = globalThis.LiteGraph || {};
    _theme = {
        bg: LG.WIDGET_BGCOLOR || g("--comfy-input-bg", "#222"),
        border: g("--border-color", "#4e4e4e"),
        text: LG.WIDGET_TEXT_COLOR || g("--input-text", "#ddd"),
        muted: LG.WIDGET_SECONDARY_TEXT_COLOR || g("--descrip-text", "#999"),
        accent: g("--p-primary-color", "#60a5fa"),
        danger: g("--p-red-400", "#f87171"),
        font: "12px " + (LG.NODE_FONT || "sans-serif"),
        mono: "12px " + (LG.NODE_FONT || "monospace"),
    };
    return _theme;
}

// -----------------------------------------------------------------------------
// 小工具
// -----------------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round(v * 100) / 100;
const roundStep = (v, s) => round2(Math.round(v / s) * s);
const norm = (p) => (p || "").replace(/\\/g, "/");
const shortName = (name) =>
    norm(name)
        .split("/")
        .pop()
        .replace(/\.(safetensors|ckpt|pt|pth|bin|sft)$/i, "");
const isNone = (s) => !s || s === "None" || s === "null";

function parseState(value) {
    if (value && typeof value === "object" && !Array.isArray(value) && value.lora !== undefined) {
        return {
            lora: String(value.lora ?? "None"),
            w: Number.isFinite(+value.w) ? +value.w : 1.0,
            t: String(value.t ?? ""),
            e: value.e === undefined ? true : !!value.e,
        };
    }
    if (typeof value === "string" && value.trim()) {
        try {
            const d = JSON.parse(value);
            if (d && typeof d === "object" && !Array.isArray(d)) {
                return {
                    lora: typeof d.lora === "string" ? d.lora : "None",
                    w: Number.isFinite(+d.w) ? +d.w : 1.0,
                    t: typeof d.t === "string" ? d.t : "",
                    e: d.e === undefined ? true : !!d.e,
                };
            }
        } catch (e) {
            return { ...DEFAULT_STATE, lora: value.trim() }; // 兜底：纯文件名
        }
    }
    return { ...DEFAULT_STATE };
}

function parseRows(json) {
    if (!json) return [];
    try {
        const d = typeof json === "string" ? JSON.parse(json) : json;
        if (!Array.isArray(d)) return [];
        return d.map((r) => parseState(r));
    } catch (e) {
        return [];
    }
}

/**
 * 文本列表的一条：{title, text, e}
 *   title → 只给你自己看的备注，**永远不参与输出**
 *   text  → 正文，按顺序拼进合并文本
 *   e     → 这一条的开关
 * 兜底：拿到纯字符串（手改工作流）就当作正文。
 */
function parseTextState(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return {
            title: String(value.title ?? ""),
            text: String(value.text ?? ""),
            e: value.e === undefined ? true : !!value.e,
        };
    }
    if (typeof value === "string" && value.trim()) {
        try {
            const d = JSON.parse(value);
            if (d && typeof d === "object" && !Array.isArray(d)) {
                return {
                    title: String(d.title ?? ""),
                    text: String(d.text ?? ""),
                    e: d.e === undefined ? true : !!d.e,
                };
            }
        } catch (e) {
            return { ...DEFAULT_TEXT, text: value.trim() }; // 兜底：整段就是正文
        }
    }
    return { ...DEFAULT_TEXT };
}

function parseTexts(json) {
    if (!json) return [];
    try {
        const d = typeof json === "string" ? JSON.parse(json) : json;
        if (!Array.isArray(d)) return [];
        return d.slice(0, MAX_TEXTS).map((r) => parseTextState(r));
    } catch (e) {
        return [];
    }
}

function groupFiles(list) {
    const groups = new Map();
    const root = [];
    for (const f of list) {
        const n = norm(f);
        const sep = n.lastIndexOf("/");
        if (sep === -1) root.push(f);
        else {
            const dir = n.slice(0, sep);
            if (!groups.has(dir)) groups.set(dir, []);
            groups.get(dir).push({ value: f, label: shortName(f) });
        }
    }
    return {
        root,
        groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
}

// -----------------------------------------------------------------------------
// 布局（宽度不够时按 触发词 → 权重 的顺序让位，最后才压缩 LoRA 胶囊）
// -----------------------------------------------------------------------------
// 行内从左往右： 开关 | LoRA 胶囊 | 权重 | 触发词 | 删除
function zones(width, reserve) {
    const w = Math.max(width || 0, 300);
    const right = w - (reserve ?? RIGHT_RESERVE);
    const avail = right - M;
    let weightW = WEIGHT_W;
    let trigW = TRIG_W;
    const fixed = GAP * 4 + DEL_W + SW_W;

    let pill = avail - fixed - weightW - trigW;
    if (pill < 96) {
        const cut = Math.min(96 - pill, trigW - TRIG_W_MIN);
        trigW -= cut;
        pill += cut;
    }
    if (pill < 96) {
        const cut = Math.min(96 - pill, weightW - WEIGHT_W_MIN);
        weightW -= cut;
        pill += cut;
    }
    pill = Math.max(pill, 56);

    const swX = M;
    const loraX = swX + SW_W + GAP;
    const weightX = loraX + pill + GAP;
    const trigX = weightX + weightW + GAP;
    return {
        m: M,
        right,
        swX,
        swW: SW_W,
        loraX,
        loraW: pill,
        weightX,
        weightW,
        minusX: weightX,
        plusX: weightX + weightW - 26,
        trigX,
        trigW,
        delX: trigX + trigW + GAP,
        delW: DEL_W,
    };
}

function zoneAt(x, z) {
    if (x >= z.delX) return "del";
    if (x >= z.trigX) return "trig";
    if (x >= z.weightX) {
        if (x < z.minusX + 26) return "w-minus";
        if (x >= z.plusX) return "w-plus";
        return "w-drag";
    }
    if (x >= z.loraX) {
        if (x < z.loraX + ARROW_W) return "lora-prev";
        if (x >= z.loraX + z.loraW - ARROW_W) return "lora-next";
        return "lora";
    }
    if (x >= z.swX) return "sw";
    return null;
}

// 顶部行：左「总开关」，右边再切成「＋ 添加 LoRA」和「＋ 添加文本」，三者互不干扰。
// withText 由调用方给（只有提示词版节点才有文本按钮）。
function headerZones(width, reserve, withText) {
    const w = Math.max(width || 0, 300);
    const right = w - (reserve ?? RIGHT_RESERVE);
    const usable = Math.max(right - M, 200);
    const toggleW = Math.max(120, Math.round(usable * HEADER_TOGGLE_RATIO));
    const addX = M + toggleW + GAP;
    const addW = Math.max(110, usable - toggleW - GAP);

    if (!withText) {
        return { m: M, right, usable, toggleX: M, toggleW, addX, addW, textX: 0, textW: 0 };
    }

    let textW = Math.round(addW * 0.46);
    let loraW = addW - textW - GAP;
    if (loraW < HEADER_ADD_MIN || textW < HEADER_TEXT_MIN) {
        // 节点太窄：对半分，保证两个按钮都还在、只是更挤
        const half = Math.max(36, Math.round((addW - GAP) / 2));
        loraW = half;
        textW = Math.max(36, addW - half - GAP);
    }
    return {
        m: M,
        right,
        usable,
        toggleX: M,
        toggleW,
        addX,
        addW: loraW,
        textX: addX + loraW + GAP,
        textW,
    };
}

// 文本列表一行的横向分区：[ 开关 ] [ 标题(备注) ] [ 正文 ] [ ✕ ]
function textZones(width, reserve) {
    const w = Math.max(width || 0, 300);
    const right = w - (reserve ?? RIGHT_RESERVE_PROMPT);
    const avail = Math.max(right - M, 180);
    const rest = Math.max(avail - SW_W - DEL_W - GAP * 3, 150);

    let titleW = Math.round(rest * TEXT_TITLE_RATIO);
    let bodyW = rest - titleW;
    if (titleW < 70) {
        bodyW -= 70 - titleW;
        titleW = 70;
    }
    if (bodyW < 90) {
        titleW = Math.max(48, titleW - (90 - bodyW));
        bodyW = rest - titleW;
    }

    const swX = M;
    const titleX = swX + SW_W + GAP;
    const bodyX = titleX + titleW + GAP;
    return {
        m: M,
        right,
        swX,
        swW: SW_W,
        titleX,
        titleW,
        bodyX,
        bodyW,
        delX: bodyX + bodyW + GAP,
        delW: DEL_W,
    };
}

function textZoneAt(x, z) {
    if (x >= z.delX) return "del";
    if (x >= z.bodyX) return "body";
    if (x >= z.titleX) return "title";
    if (x >= z.swX) return "sw";
    return null;
}

/** 文本列表标题行右侧「✕ 删除末条」的横向范围（热区只在这个框里） */
function textDelLastZones(width, reserve) {
    const z = textZones(width, reserve);
    const bw = Math.min(TEXT_BTN_W, Math.max(56, z.right - z.m - 60));
    return { x: z.right - bw, w: bw, right: z.right };
}

// -----------------------------------------------------------------------------
// 绘制原语
// -----------------------------------------------------------------------------
function rr(ctx, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.arcTo(x + w, y, x + w, y + h, k);
    ctx.arcTo(x + w, y + h, x, y + h, k);
    ctx.arcTo(x, y + h, x, y, k);
    ctx.arcTo(x, y, x + w, y, k);
    ctx.closePath();
}
function clipText(ctx, text, maxW) {
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
}

/**
 * 按逗号优先断行，返回最多 maxLines 行；放不下的丢弃（调用方自己决定怎么提示）。
 * 提示词用逗号分隔，按逗号断行读起来最自然。
 */
function wrapText(ctx, text, maxW, maxLines) {
    const lines = [];
    if (!text || maxW <= 0 || maxLines <= 0) return lines;
    const tokens = [];
    let rest = String(text);
    for (;;) {
        const i = rest.indexOf(", ");
        if (i < 0) break;
        tokens.push(rest.slice(0, i + 2));
        rest = rest.slice(i + 2);
    }
    if (rest) tokens.push(rest);
    let cur = "";
    for (const tk of tokens) {
        if (lines.length >= maxLines) break;
        const test = cur + tk;
        if (ctx.measureText(test).width <= maxW) {
            cur = test;
            continue;
        }
        if (cur) {
            lines.push(cur.trim());
            if (lines.length >= maxLines) break;
            cur = tk;
        } else {
            cur = tk;
        }
        // 单个片段本身就超宽 → 硬切
        while (cur && ctx.measureText(cur).width > maxW) {
            let cut = cur.length;
            while (cut > 1 && ctx.measureText(cur.slice(0, cut)).width > maxW) cut -= 1;
            lines.push(cur.slice(0, cut).trim());
            if (lines.length >= maxLines) break;
            cur = cur.slice(cut);
        }
    }
    if (lines.length < maxLines && cur) lines.push(cur.trim());
    while (lines.length > maxLines) lines.pop();
    return lines.filter((s) => s !== "");
}

/**
 * 读外部接进来的 text_in（如果上游是普通文本控件）。
 * 拿不到就返回空 —— 预览只是"看个大概"，真正拼接以后端执行结果为准。
 */
function readTextIn(node) {
    try {
        const inp = (node.inputs || []).find((i) => i.name === "text_in");
        if (!inp || inp.link == null) return "";
        const g = node.graph;
        if (!g) return "";
        const link = typeof g.getLink === "function" ? g.getLink(inp.link) : g.links?.[inp.link];
        if (!link) return "";
        const src = typeof g.getNodeById === "function" ? g.getNodeById(link.origin_id) : null;
        if (!src) return "";
        const w = (src.widgets || []).find(
            (x) => x && typeof x.value === "string" && x.value.trim() !== ""
        );
        return w ? w.value : "";
    } catch (e) {
        return "";
    }
}

/**
 * 判断一个字符串是不是"某一行的状态 JSON"（{lora, w, t, e}）。
 * 用来识别旧版本控件错位 bug 留在提示词框里的垃圾值 —— 只认整段就是这种对象的，
 * 正常提示词不会长这样，所以不会误伤。
 */
function isRowStateJson(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 8 || t[0] !== "{" || t[t.length - 1] !== "}") return false;
    try {
        const o = JSON.parse(t);
        if (!o || typeof o !== "object" || Array.isArray(o)) return false;
        const keys = Object.keys(o);
        return keys.includes("lora") && keys.includes("e") && keys.every((k) => k === "lora" || k === "w" || k === "t" || k === "e");
    } catch (e) {
        return false;
    }
}

/**
 * 本次实际会拼进去的触发词（启用中的行、总开关打开）。空串跳过。
 * 单独抽出来是因为预览框要把它固定在显眼位置显示 —— 用户最想确认的就是这个。
 */
function triggerListOf(node) {
    const st = node.__xiaolan;
    if (!st) return "";
    const masterOn = st.toggle ? !!st.toggle.value : true;
    if (!masterOn) return "";
    const out = [];
    for (const w of st.rows) {
        const s = parseState(w.value);
        if (s.e === false) continue;
        const t = String(s.t == null ? "" : s.t)
            .trim()
            .replace(/^[,\s]+/, "")
            .replace(/[,\s]+$/, "");
        if (t) out.push(t);
    }
    return out.join(", ");
}

/**
 * 本次会拼进去的「文本列表」正文（按顺序，跳过被关掉的条目）。
 * 标题只是备注，不在这里出现 —— 和后端 _parse_texts_data 的规则一致。
 */
function textListOf(node) {
    const st = node.__xiaolan;
    if (!st || !st.texts) return [];
    const out = [];
    for (const w of st.texts) {
        const s = parseTextState(w.value);
        if (s.e === false) continue;
        const t = s.text
            .trim()
            .replace(/^[,\s]+/, "")
            .replace(/[,\s]+$/, "");
        if (t) out.push(t);
    }
    return out;
}
function textListText(node) {
    return textListOf(node).join(", ");
}

/**
 * 最终合并文本 —— 必须和后端 _merge_text/_apply_rows/_parse_texts_data 的规则一致：
 *   [text_in] + 提示词 + 文本列表正文 + 各"启用中"行的触发词，逗号连接，空串跳过；
 *   总开关关掉时，触发词一律不参与（后端是直接旁路的）；
 *   文本列表受每条自己的开关控制，不受总开关影响（和后端的提示词一样）。
 */
function mergedTextOf(node) {
    const st = node.__xiaolan;
    if (!st) return "";
    const parts = [];
    const push = (v) => {
        const s = String(v == null ? "" : v)
            .trim()
            .replace(/^[,\s]+/, "")
            .replace(/[,\s]+$/, "");
        if (s) parts.push(s);
    };
    push(readTextIn(node));
    if (st.promptW) push(st.promptW.value);
    push(textListText(node));
    push(triggerListOf(node));
    return parts.join(", ");
}

/**
 * 提示词框 / 预览框的横向分栏比例（0.58 = 提示词框占可用宽度的 58%）。
 *
 * 这个比例是**用户可调**的：拖中间那条分隔条即可，存在 node.properties 里
 * （不动 widgets_values，所以不影响控件值的顺序，也不用再给回填逻辑加分支）。
 * 工作流存盘时会连 properties 一起存，下次打开还是你拖过的样子。
 */
function splitRatioOf(node) {
    const v = node?.properties?.xiaolanPromptSplit;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return PROMPT_SPLIT;
    return clamp(n, PROMPT_SPLIT_MIN, PROMPT_SPLIT_MAX);
}

function setSplitRatio(node, r) {
    if (!node) return;
    if (!node.properties) node.properties = {};
    node.properties.xiaolanPromptSplit = round2(clamp(r, PROMPT_SPLIT_MIN, PROMPT_SPLIT_MAX));
}

/**
 * 提示词框 / 预览框的横向分栏。
 * boxW 是"节点坐标系下交给 DOM 控件的宽度"，DOM 层会再各减一个 margin，
 * 所以提示词框的可视区是 [margin, boxW - margin]。
 * 两侧都留最小宽度：比例被拖到极端时也不会把某一边挤没。
 */
function promptSplit(node) {
    const total = Math.max((node.size && node.size[0]) || NODE_W, NODE_W);
    const right = total - reserveOf(node);
    const avail = Math.max(right - M, 200);
    const maxBox = Math.max(SPLIT_MIN_BOX, avail - GAP - PREVIEW_MIN_W);
    const boxW = Math.round(clamp(avail * splitRatioOf(node), SPLIT_MIN_BOX, maxBox));
    const preX = boxW + GAP;
    const preW = Math.max(0, right - preX);
    return { boxW, preX, preW, right };
}

/**
 * 分隔条的横向位置：视觉上正好落在两个框之间那道空隙的中心。
 * 提示词框是 DOM 控件，左右各内缩一个 margin，所以视觉右边缘是 boxW - margin；
 * 预览框从 boxW + GAP 起画 → 中心 = boxW + (GAP - margin) / 2。
 */
function splitXOf(node) {
    const pw = node?.__xiaolan?.promptW;
    const mg = pw && typeof pw.margin === "number" ? pw.margin : 10;
    return promptSplit(node).boxW + (GAP - mg) / 2;
}

/** 指针是不是正压在分隔条上（用来起拖拽 / 画高亮） */
function splitHitAt(node, lx, ly) {
    const st = node?.__xiaolan;
    if (!st || !st.promptMode || !st.promptW) return false;
    const pw = st.promptW;
    const mg = typeof pw.margin === "number" ? pw.margin : 10;
    const y0 = (pw.y || 0) + mg;
    const h = (pw.computedHeight || st.promptH) - mg * 2;
    if (!(y0 > 0) || h <= 0) return false;
    if (ly < y0 - 4 || ly > y0 + h + 4) return false;
    return Math.abs(lx - splitXOf(node)) <= SPLIT_HIT;
}

/**
 * 拖动分隔条改分栏比例。
 * 用 document 级监听，指针移出节点也不会丢事件；换算用画布缩放，缩放下手感一致。
 */
function beginSplitDrag(node, clientX) {
    const st = node.__xiaolan;
    if (!st) return;
    const startX = clientX;
    const startRatio = splitRatioOf(node);
    const total = Math.max(node.size?.[0] || NODE_W, NODE_W);
    const avail = Math.max(total - reserveOf(node) - M, 200);
    const scale = canvasScale() || 1;
    st.splitDragging = true;

    const move = (ev) => {
        const dx = ((ev.clientX ?? 0) - startX) / scale;
        setSplitRatio(node, startRatio + dx / avail);
        setDirty();
    };
    const up = () => {
        st.splitDragging = false;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        setDirty();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
}

/** 分隔条：中间一截"抓手"，悬停/拖动时点亮 */
function drawSplitter(ctx, node, sp, y0, h) {
    const st = node.__xiaolan;
    const c = T();
    const x = splitXOf(node);
    const active = !!st.splitDragging;
    const hot = active || (st.hover && st.hover.zone === "split");
    if (h < 24) return;

    const gh = Math.min(SPLIT_GRIP_H, h - 12);
    const gy = y0 + (h - gh) / 2;
    const color = hot ? c.accent : c.border;

    ctx.save();
    // 拖动态再补一条贯穿的细线，让"正在调这里"更明确
    if (active) {
        ctx.strokeStyle = c.accent;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y0);
        ctx.lineTo(x + 0.5, y0 + h);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color;
    ctx.globalAlpha = hot ? 1 : 0.75;
    rr(ctx, x - 2, gy, 4, gh, 2);
    ctx.fill();
    // 三个小点：一眼看出"这里能拖"
    const dots = [gy + gh * 0.34, gy + gh * 0.5, gy + gh * 0.66];
    ctx.globalAlpha = hot ? 1 : 0.6;
    for (const dy of dots) {
        ctx.beginPath();
        ctx.arc(x, dy, 1.4, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}
function tri(ctx, x, y, w, h, dir) {
    ctx.beginPath();
    if (dir === "left") {
        ctx.moveTo(x + w, y);
        ctx.lineTo(x, y + h / 2);
        ctx.lineTo(x + w, y + h);
    } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x, y + h);
    }
    ctx.closePath();
    ctx.fill();
}
function field(ctx, x, y, w, h, radius, hi) {
    const c = T();
    ctx.fillStyle = c.bg;
    rr(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = hi ? c.accent : c.border;
    ctx.lineWidth = 1;
    ctx.stroke();
}
/** 虚线框：用来标记"只是备注、不参与输出"的字段（和入参框区分开） */
function fieldDashed(ctx, x, y, w, h, radius, hi, color) {
    const c = T();
    ctx.save();
    ctx.setLineDash([3, 3]);
    rr(ctx, x, y, w, h, radius);
    ctx.fillStyle = c.bg;
    ctx.fill();
    ctx.strokeStyle = hi ? c.accent : color || c.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
}
function plusMinus(ctx, x, y, w, h, sign, color) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    if (sign === "+") {
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx, cy + 4);
    }
    ctx.stroke();
}
function cross(ctx, x, y, w, h, color) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 4.5, cy - 4.5);
    ctx.lineTo(cx + 4.5, cy + 4.5);
    ctx.moveTo(cx + 4.5, cy - 4.5);
    ctx.lineTo(cx - 4.5, cy + 4.5);
    ctx.stroke();
}
/** 单行开关（小胶囊） */
function switchBox(ctx, x, y, w, h, on, hi) {
    const c = T();
    const tw = 26;
    const th = 14;
    const tx = x + (w - tw) / 2;
    const ty = y + (h - th) / 2;
    if (on) {
        ctx.fillStyle = c.accent;
        rr(ctx, tx, ty, tw, th, th / 2);
        ctx.fill();
    } else {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        rr(ctx, tx, ty, tw, th, th / 2);
        ctx.fill();
        ctx.strokeStyle = hi ? c.accent : c.border;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    const kr = th - 4;
    const kx = on ? tx + tw - kr - 2 : tx + 2;
    ctx.beginPath();
    ctx.arc(kx + kr / 2, ty + th / 2, kr / 2, 0, Math.PI * 2);
    ctx.fillStyle = on ? "#ffffff" : hi ? c.accent : c.muted;
    ctx.fill();
}

// -----------------------------------------------------------------------------
// 布局防死循环：写死控件起始 y
// 新版前端 arrange() 会把「端口包围盒底部」当控件起点，本节点端口贴行绘制，
// 于是互相推高（实测每帧 +98px，节点被撑爆）。固定住即可打断。
// -----------------------------------------------------------------------------
function pinStartY(node) {
    try {
        if (node.widgets_start_y !== TOP_Y) node.widgets_start_y = TOP_Y;
    } catch (e) {
        /* ignore */
    }
}

function layoutOutputs(node) {
    const st = node.__xiaolan;
    const outs = node.outputs;
    if (!st || !outs || outs.length < 2) return;
    const x = Math.max(node.size[0] - 9, 20);

    outs[0].pos = [x, HEADER_OUT_Y[0]];
    if (outs[0].label !== "model") outs[0].label = "model";
    outs[1].pos = [x, HEADER_OUT_Y[1]];
    // 提示词版节点输出的是"提示词 + 触发词"，端口名更长，右侧预留也更多
    const mergedLabel = st.promptMode ? "文本触发词合并输出" : "触发词合并输出";
    if (outs[1].label !== mergedLabel) outs[1].label = mergedLabel;

    const rows = st.rows;
    const n = rows.length;
    const baseY =
        rows[0] && typeof rows[0].y === "number" && rows[0].y > 0 ? rows[0].y : TOP_Y + 24;
    const rowCenter = (i) => baseY + (i - 1) * (ROW_H + ROW_GAP) + ROW_H / 2;
    const lastVisible = Math.max(Math.min(n, MAX_OUT), 1);

    // 触发词1..触发词30 固定在输出 2..2+MAX_OUT-1
    for (let k = 2; k < 2 + MAX_OUT && k < outs.length; k++) {
        const i = k - 1;
        const o = outs[k];
        if (i <= n) {
            o.pos = [x, rowCenter(i)];
            const want = `触发词${i}`;
            if (o.label !== want) o.label = want;
        } else {
            // 该前端版本绘制输出端口时不看 output.hidden，于是把未用端口压到最后一条
            // 可见端口上；label 必须用单个空格（空串会被回退成 name，反而画出"触发词30"）
            o.pos = [x, rowCenter(lastVisible)];
            if (o.label !== " ") o.label = " ";
        }
    }

    // ---------------- 提示词行的出入口（仅提示词版） ----------------
    if (!st.promptMode) return;
    const labelY =
        st.promptLabel && typeof st.promptLabel.y === "number" && st.promptLabel.y > 0
            ? st.promptLabel.y + HINT_H / 2
            : rowCenter(lastVisible) + ROW_H / 2 + HINT_H / 2 + ROW_GAP;

    // 文本输出：追加在最后的那个输出端口，放到提示词说明那一行的右端
    for (let k = 2 + MAX_OUT; k < outs.length; k++) {
        const o = outs[k];
        o.pos = [x, labelY];
        if (o.label !== "文本输出") o.label = "文本输出";
    }

    // 文本输入：输入端口本来贴在左侧，把它拉到同一行
    for (const inp of node.inputs || []) {
        if (inp.name !== "text_in") continue;
        inp.pos = [0, labelY];
        if (inp.label !== "文本输入") inp.label = "文本输入";
    }
}

function setDirty() {
    try {
        const c = getApp()?.canvas;
        if (!c) return;
        if (typeof c.setDirty === "function") c.setDirty(true, true);
        else if (typeof c.setDirtyCanvas === "function") c.setDirtyCanvas(true, true);
    } catch (e) {
        /* ignore */
    }
}
function evKind(e) {
    const t = (e && e.type) || "";
    if (/down/i.test(t)) return "down";
    if (/move/i.test(t)) return "move";
    if (/up/i.test(t)) return "up";
    return "other";
}
function canvasToScreen(node, x, y) {
    try {
        const c = getApp().canvas;
        const ds = c.ds || {};
        const el = c.canvasEl || c.canvas || document.querySelector("canvas");
        const rect = el.getBoundingClientRect();
        const scale = ds.scale ?? 1;
        const off = ds.offset || [0, 0];
        return [
            rect.left + (node.pos[0] + x + off[0]) * scale,
            rect.top + (node.pos[1] + y + off[1]) * scale,
        ];
    } catch (e) {
        return [null, null];
    }
}
function canvasScale() {
    try {
        return getApp().canvas.ds.scale || 1;
    } catch (e) {
        return 1;
    }
}

// -----------------------------------------------------------------------------
// 悬停高亮
// ⚠ 实测：litegraph 只在「按住鼠标」时才把 pointermove 派发给 widget.mouse，
//    单纯移动时不会调用，所以悬停必须自己在 document 上跟踪。
// -----------------------------------------------------------------------------
let hoverBound = false;
let hoverRaf = 0;
let hoverLast = [NaN, NaN];
let splitDragNode = null; // 正在被拖的分隔条所属节点
let splitCursorOn = false;

/** 屏幕坐标 → 画布全局坐标（不在画布内返回 null） */
function clientToLocal(clientX, clientY) {
    const c = getApp()?.canvas;
    if (!c || !c.ds) return null;
    const el = c.canvasEl || c.canvas || document.querySelector("canvas");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        return null;
    }
    const scale = c.ds.scale || 1;
    const off = c.ds.offset || [0, 0];
    return {
        gx: (clientX - rect.left) / scale - off[0],
        gy: (clientY - rect.top) / scale - off[1],
    };
}

/** 哪个节点的分隔条被压住了 */
function findSplitHit(clientX, clientY) {
    const pos = clientToLocal(clientX, clientY);
    if (!pos) return null;
    let found = null;
    forEachOurNode((n) => {
        if (found) return;
        if (n.__xiaolan?.promptMode && splitHitAt(n, pos.gx - n.pos[0], pos.gy - n.pos[1])) found = n;
    });
    return found;
}

/**
 * 分隔条的鼠标指针样式。
 * litegraph 每次 pointermove 都会重设 canvas 的 cursor，我们排在它后面（rAF 里）覆盖；
 * 用 !important 才压得住它写在内联样式上的值，离开时再撤掉。
 */
function setSplitCursor(on) {
    if (on === splitCursorOn) return;
    splitCursorOn = on;
    const el = getApp()?.canvas?.canvasEl || document.querySelector("canvas");
    if (!el || !el.style) return;
    try {
        if (on) el.style.setProperty("cursor", "col-resize", "important");
        else el.style.removeProperty("cursor");
    } catch (e) {
        /* ignore */
    }
}

function forEachOurNode(fn) {
    const nodes = getApp()?.graph?._nodes;
    if (!nodes) return;
    for (const n of nodes) {
        if (n && n.__xiaolan_ready && n.__xiaolan) fn(n);
    }
}
function clearHover() {
    forEachOurNode((n) => {
        if (n.__xiaolan.hover) {
            n.__xiaolan.hover = null;
            setDirty();
        }
    });
    setSplitCursor(false);
}

/**
 * 给一个节点内的局部坐标，算出悬停在哪个热区。
 * 顶部三按钮 / 文本列表说明行 / LoRA 行 / 文本行，各查各的横向分区。
 */
function hoverAt(node, lx, ly) {
    const st = node.__xiaolan;
    if (!st) return null;
    if (lx < 0 || lx > node.size[0] || ly < 0 || ly > node.size[1]) return null;

    // 顶部那一行：左总开关 / 中＋添加 LoRA / 右＋添加文本
    const hw = st.header;
    const hy = hw && typeof hw.y === "number" ? hw.y : -9999;
    if (ly >= hy - 3 && ly <= hy + HEADER_H + 3) {
        const z = headerZones(node.size[0], reserveOf(node), hasTextList(node));
        if (z.textW && lx >= z.textX && lx <= z.textX + z.textW) return { row: "header", zone: "add-text" };
        if (lx >= z.addX && lx <= z.addX + z.addW) return { row: "header", zone: "add" };
        if (lx >= z.toggleX && lx <= z.toggleX + z.toggleW) return { row: "header", zone: "toggle" };
        return null;
    }

    // 文本列表说明行（只在有条目时存在）
    const th = st.textHeader;
    if (th && !th.hidden && typeof th.y === "number" && ly >= th.y - 2 && ly <= th.y + TEXT_HEADER_H + 2) {
        const btn = textDelLastZones(node.size[0], reserveOf(node));
        return { row: "text-header", zone: lx >= btn.x && lx <= btn.x + btn.w ? "del-last" : null };
    }

    // LoRA 行
    const z = zones(node.size[0], reserveOf(node));
    for (const w of st.rows) {
        const wy = typeof w.y === "number" ? w.y : -9999;
        if (ly >= wy - 2 && ly <= wy + ROW_H + 2) return { row: w._index, zone: zoneAt(lx, z) };
    }

    // 文本行
    const tz = textZones(node.size[0], reserveOf(node));
    for (const w of st.texts || []) {
        const wy = typeof w.y === "number" ? w.y : -9999;
        if (ly >= wy - 2 && ly <= wy + ROW_H + 2) {
            return { row: `t${w._index}`, zone: textZoneAt(lx, tz) };
        }
    }

    // 提示词框与预览框之间的分隔条（可以按住左右拖）
    if (splitHitAt(node, lx, ly)) return { row: "split", zone: "split" };

    return null;
}

function updateHover(clientX, clientY) {
    const pos = clientToLocal(clientX, clientY);
    let overSplit = false;
    forEachOurNode((n) => {
        const hover = pos ? hoverAt(n, pos.gx - n.pos[0], pos.gy - n.pos[1]) : null;
        if (hover && hover.zone === "split") overSplit = true;
        const cur = n.__xiaolan.hover;
        const same = !cur && !hover ? true : !!(cur && hover && cur.row === hover.row && cur.zone === hover.zone);
        if (!same) {
            n.__xiaolan.hover = hover;
            setDirty();
        }
    });
    // 拖动过程中即使被限位卡住、指针暂时离开分隔条，指针样式也别跳回箭头
    setSplitCursor(overSplit || !!splitDragNode);
}
function bindHoverTracking() {
    if (hoverBound) return;
    hoverBound = true;
    const onMove = (ev) => {
        hoverLast = [ev.clientX, ev.clientY];
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
            hoverRaf = 0;
            try {
                updateHover(hoverLast[0], hoverLast[1]);
            } catch (e) {
                /* ignore */
            }
        });
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerleave", () => clearHover(), true);
    window.addEventListener("blur", () => clearHover());

    // 分隔条拖拽。
    // ★ 必须在【捕获阶段】就把 pointerdown 拦下来：不然事件继续传到画布，
    //   litegraph 找不到能处理它的控件，就会当成"按住节点拖动" → 拖分隔条变成拖整个节点。
    const onDown = (ev) => {
        if (splitDragNode || ev.button !== 0) return;
        const node = findSplitHit(ev.clientX, ev.clientY);
        if (!node) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        splitDragNode = node;
        const clear = () => {
            splitDragNode = null;
            document.removeEventListener("pointerup", clear, true);
            document.removeEventListener("pointercancel", clear, true);
        };
        document.addEventListener("pointerup", clear, true);
        document.addEventListener("pointercancel", clear, true);
        beginSplitDrag(node, ev.clientX);
    };
    document.addEventListener("pointerdown", onDown, true);

    // 双击 = 恢复默认比例。
    // ⚠ 别用 pointerdown 的 ev.detail 判双击 —— PointerEvent 规范里 pointerdown 的
    //   detail **恒为 0**（实测 Chrome 也是），拿它判断永远不成立。直接用 dblclick 事件。
    const onDbl = (ev) => {
        const node = findSplitHit(ev.clientX, ev.clientY);
        if (!node) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        setSplitRatio(node, PROMPT_SPLIT);
        setDirty();
    };
    document.addEventListener("dblclick", onDbl, true);
}

// -----------------------------------------------------------------------------
// LoRA 列表：只取一次并缓存（避免"疯狂加载"）
// -----------------------------------------------------------------------------
let loraCache = null;
let loraLoading = null;
let loraFailed = false;

async function fetchLoraList() {
    if (Array.isArray(loraCache)) return loraCache;
    if (loraFailed) return ["None"];
    if (loraLoading) return loraLoading;
    loraLoading = (async () => {
        try {
            const r = await fetch("object_info/LoraLoader");
            if (!r.ok) throw new Error("HTTP " + r.status);
            const d = await r.json();
            const rd = d?.LoraLoader?.input?.required || {};
            const op = d?.LoraLoader?.input?.optional || {};
            // 本机字段名是 lora_name（兼容旧版 lora）
            const list = rd.lora_name?.[0] || rd.lora?.[0] || op.lora_name?.[0] || op.lora?.[0];
            loraCache = Array.isArray(list) && list.length ? list.slice() : [];
        } catch (e) {
            console.warn("[小岚lora阵列] 获取 LoRA 列表失败:", e);
            loraFailed = true;
            loraCache = [];
        } finally {
            loraLoading = null;
        }
        return loraCache;
    })();
    return loraLoading;
}

// -----------------------------------------------------------------------------
// 绘制一行
// -----------------------------------------------------------------------------
function drawRow(ctx, node, widget, width, y) {
    pinStartY(node);
    layoutOutputs(node);

    const st = parseState(widget.value);
    const z = zones(width, reserveOf(node));
    const c = T();
    const cy = y + ROW_H / 2;
    const hv = node.__xiaolan?.hover;
    const hz = hv && hv.row === widget._index ? hv.zone : null;
    const on = st.e !== false;

    ctx.save();
    ctx.textBaseline = "middle";

    // 停用的行整体压暗，一眼能看出哪些没生效
    // （开关与删除不在压暗范围内，要保持可点）
    ctx.save();
    if (!on) ctx.globalAlpha = 0.42;

    // ---------- LoRA 胶囊 ----------
    const empty = isNone(st.lora);
    field(ctx, z.loraX, y, z.loraW, ROW_H, ROW_H / 2, hz && hz.startsWith("lora"));
    if (empty) {
        ctx.font = c.font;
        ctx.textAlign = "center";
        ctx.fillStyle = c.accent;
        ctx.fillText(clipText(ctx, "＋ 点击选择 LoRA", z.loraW - 8), z.loraX + z.loraW / 2, cy + 1);
    } else {
        const hiArrow = hz === "lora-prev" || hz === "lora-next";
        ctx.fillStyle = hiArrow ? c.accent : c.muted;
        tri(ctx, z.loraX + 9, cy - 4, 6, 8, "left");
        tri(ctx, z.loraX + z.loraW - 15, cy - 4, 6, 8, "right");
        ctx.font = c.font;
        ctx.textAlign = "center";
        ctx.fillStyle = c.text;
        ctx.fillText(
            clipText(ctx, shortName(st.lora), z.loraW - 4 - ARROW_W * 2),
            z.loraX + z.loraW / 2,
            cy + 1
        );
    }

    // ---------- 权重 ----------
    const whz = hz === "w-minus" || hz === "w-plus" || hz === "w-drag";
    field(ctx, z.weightX, y, z.weightW, ROW_H, 6, whz);
    plusMinus(ctx, z.minusX, y, 26, ROW_H, "-", hz === "w-minus" ? c.accent : c.muted);
    plusMinus(ctx, z.plusX, y, 26, ROW_H, "+", hz === "w-plus" ? c.accent : c.muted);
    ctx.font = c.mono;
    ctx.textAlign = "center";
    ctx.fillStyle = st.w === 0 ? c.muted : c.text;
    ctx.fillText(st.w.toFixed(2), z.weightX + z.weightW / 2, cy + 1);

    // ---------- 触发词 ----------
    field(ctx, z.trigX, y, z.trigW, ROW_H, 6, hz === "trig");
    ctx.font = c.font;
    ctx.textAlign = "left";
    if (st.t) {
        ctx.fillStyle = c.text;
        ctx.fillText(clipText(ctx, st.t, z.trigW - 16), z.trigX + 8, cy + 1);
    } else {
        ctx.fillStyle = c.muted;
        ctx.fillText("触发词…", z.trigX + 8, cy + 1);
    }
    ctx.restore(); // 结束压暗

    // ---------- 单独开关（最左，不压暗，保持可点） ----------
    switchBox(ctx, z.swX, y, z.swW, ROW_H, on, hz === "sw");

    // ---------- 删除 ----------
    if (hz === "del") {
        ctx.fillStyle = "rgba(248,113,113,0.14)";
        rr(ctx, z.delX + 1, y + 1, z.delW - 2, ROW_H - 2, 6);
        ctx.fill();
    }
    cross(ctx, z.delX, y, z.delW, ROW_H, hz === "del" ? c.danger : c.muted);

    ctx.restore();
}

/**
 * 顶部一行：左边「总开关」，右边「＋ 添加 LoRA」。
 * 添加按钮放这里是为了位置固定 —— 挂在底部的话每加一行它就往下跑，
 * 点完还得追着鼠标找它。
 */
function drawHeader(ctx, node, width, y) {
    pinStartY(node);
    layoutOutputs(node);
    const st = node.__xiaolan;
    if (!st) return;
    const z = headerZones(width, reserveOf(node), hasTextList(node));
    const c = T();
    const hv = st.hover;
    const tOn = st.toggle ? !!st.toggle.value : true;
    const cy = y + HEADER_H / 2;

    ctx.save();
    ctx.textBaseline = "middle";

    // ---------- 总开关 ----------
    const hzT = hv && hv.zone === "toggle";
    field(ctx, z.toggleX, y, z.toggleW, HEADER_H, 6, hzT);
    ctx.font = c.font;
    ctx.textAlign = "left";
    ctx.fillStyle = tOn ? c.text : c.muted;
    ctx.fillText("总开关", z.toggleX + 10, cy + 1);
    switchBox(ctx, z.toggleX + z.toggleW - SW_W - 8, y, SW_W, HEADER_H, tOn, hzT);

    // ---------- 添加按钮（虚线框 = "点一下会多出一个框来"） ----------
    const ghostBtn = (bx, bw, label, hi, color) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = hi ? 1.5 : 1;
        ctx.globalAlpha = hi ? 1 : 0.9;
        if (!hi) ctx.setLineDash([4, 3]);
        rr(ctx, bx, y, bw, HEADER_H, 6);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (hi) {
            ctx.fillStyle = color + "24"; // 淡淡的填充，约 14% 不透明度
            ctx.fill();
        }
        ctx.restore();
        ctx.textAlign = "center";
        ctx.font = c.font;
        ctx.fillStyle = color;
        ctx.fillText(clipText(ctx, label, bw - 8), bx + bw / 2, cy + 1);
    };

    ghostBtn(z.addX, z.addW, "＋ 添加 LoRA", hv && hv.zone === "add", c.accent);
    if (z.textW) {
        ghostBtn(z.textX, z.textW, "＋ 添加文本", hv && hv.zone === "add-text", TEXT_COLOR);
    }

    ctx.restore();
}

/** 行数超过独立端口数时的说明行（只在需要时占高度） */
function drawHint(ctx, node, width, y) {
    const st = node.__xiaolan;
    if (!st || st.rows.length < MAX_OUT) return;
    const c = T();
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = c.font;
    ctx.fillStyle = c.muted;
    ctx.fillText(
        `超过 ${MAX_OUT} 行的部分没有独立端口，只并入合并输出`,
        Math.max(width, 160) / 2,
        y + HINT_H / 2 + 1
    );
    ctx.restore();
}

// -----------------------------------------------------------------------------
// 文本列表（仅提示词版）
//   就是一个"可以增删的文本条目列表"：每条有自己的标题（备注，不输出）和正文，
//   正文按顺序拼进「文本触发词合并输出」。
//   说明行右侧的「✕ 删除末条」是给"手滑多点了两下添加"准备的后悔药。
// -----------------------------------------------------------------------------
function textHeaderLabel(n) {
    if (!n) return "文本列表";
    return `文本列表 · ${n} 条（标题仅备注，不输出）`;
}

function drawTextHeader(ctx, node, width, y) {
    const st = node.__xiaolan;
    if (!st || !st.texts || !st.texts.length) return;
    const c = T();
    const z = textZones(width, reserveOf(node));
    const n = st.texts.length;
    const hv = st.hover;
    const hz = hv && hv.row === "text-header" ? hv.zone : null;

    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = c.font;

    // 左侧小竖条：把"文本列表"和上面的 LoRA 行在视觉上分开
    ctx.fillStyle = TEXT_COLOR;
    ctx.globalAlpha = 0.55;
    rr(ctx, z.m, y + 4, 2, TEXT_HEADER_H - 8, 1);
    ctx.fill();
    ctx.globalAlpha = 1;

    const btn = textDelLastZones(width, reserveOf(node));
    const labelW = Math.max(btn.x - z.m - 16, 60);
    ctx.fillStyle = c.muted;
    ctx.fillText(clipText(ctx, textHeaderLabel(n), labelW), z.m + 8, y + TEXT_HEADER_H / 2 + 1);

    // 右侧「✕ 删除末条」：热区严格等于这个框
    const bh = TEXT_HEADER_H - 4;
    const by = y + 2;
    const hi = hz === "del-last";
    ctx.save();
    ctx.strokeStyle = hi ? c.danger : c.border;
    ctx.lineWidth = hi ? 1.4 : 1;
    rr(ctx, btn.x, by, btn.w, bh, 5);
    if (hi) {
        ctx.fillStyle = "rgba(248,113,113,0.14)";
        ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = "center";
    ctx.font = c.font;
    ctx.fillStyle = hi ? c.danger : c.muted;
    ctx.fillText("✕ 删除末条", btn.x + btn.w / 2, by + bh / 2 + 1);
    ctx.restore();
}

/** 文本列表里的一行：[ 开关 ] [ 标题 ] [ 正文 ] [ ✕ ] */
function drawTextRow(ctx, node, widget, width, y) {
    pinStartY(node);
    layoutOutputs(node);

    const s = parseTextState(widget.value);
    const z = textZones(width, reserveOf(node));
    const c = T();
    const cy = y + ROW_H / 2;
    const hv = node.__xiaolan?.hover;
    const hz = hv && hv.row === `t${widget._index}` ? hv.zone : null;
    const on = s.e !== false;

    ctx.save();
    ctx.textBaseline = "middle";

    ctx.save();
    if (!on) ctx.globalAlpha = 0.42;

    // ---------- 标题：虚线框 + 偏冷色，暗示"这只是备注" ----------
    fieldDashed(ctx, z.titleX, y, z.titleW, ROW_H, 6, hz === "title", TEXT_COLOR);
    ctx.font = c.font;
    ctx.textAlign = "left";
    if (s.title) {
        ctx.fillStyle = TEXT_COLOR;
        ctx.fillText(clipText(ctx, s.title, z.titleW - 16), z.titleX + 8, cy + 1);
    } else {
        ctx.fillStyle = c.muted;
        ctx.fillText(clipText(ctx, "标题/备注…", z.titleW - 16), z.titleX + 8, cy + 1);
    }

    // ---------- 正文 ----------
    field(ctx, z.bodyX, y, z.bodyW, ROW_H, 6, hz === "body");
    ctx.font = c.font;
    ctx.textAlign = "left";
    if (s.text) {
        ctx.fillStyle = c.text;
        ctx.fillText(clipText(ctx, s.text, z.bodyW - 16), z.bodyX + 8, cy + 1);
    } else {
        ctx.fillStyle = c.muted;
        ctx.fillText(clipText(ctx, "文本内容…", z.bodyW - 16), z.bodyX + 8, cy + 1);
    }
    ctx.restore(); // 结束压暗

    // ---------- 这条的开关（最左，不压暗，保持可点） ----------
    switchBox(ctx, z.swX, y, z.swW, ROW_H, on, hz === "sw");

    // ---------- 删除 ----------
    if (hz === "del") {
        ctx.fillStyle = "rgba(248,113,113,0.14)";
        rr(ctx, z.delX + 1, y + 1, z.delW - 2, ROW_H - 2, 6);
        ctx.fill();
    }
    cross(ctx, z.delX, y, z.delW, ROW_H, hz === "del" ? c.danger : c.muted);

    ctx.restore();
}

/**
 * 提示词框右侧的「最终文本预览」：只读，实时显示合并结果。
 * 用户不用再为了确认"触发词到底拼上没有"去执行一次、再挂个 Show Text 看。
 *
 * 位置每帧从 promptW 的真实几何推出来，所以提示词框被拉高、节点被拉宽，预览都跟着走。
 * 顺手把 promptW.width 设成左半栏 —— DOM 控件的横向占位就靠它
 * （DomWidgets.vue 里 size[0] = (widget.width ?? node.width) - margin*2）。
 */
function drawPromptPreview(ctx, node) {
    const st = node.__xiaolan;
    if (!st || !st.promptMode || !st.promptW) return;
    const pw = st.promptW;
    const mg = typeof pw.margin === "number" ? pw.margin : 10;
    const sp = promptSplit(node);
    if (pw.width !== sp.boxW) pw.width = sp.boxW;

    const y0 = (pw.y || 0) + mg;
    const h = (pw.computedHeight || st.promptH) - mg * 2;
    if (!(y0 > 0) || h <= 0) return;

    // 分隔条无论如何都要画：预览框被挤没了的时候，用户还得靠它拖回来
    drawSplitter(ctx, node, sp, y0, h);
    if (sp.preW < PREVIEW_MIN_W) return;

    const c = T();
    ctx.save();
    rr(ctx, sp.preX, y0, sp.preW, h, 7);
    ctx.fillStyle = c.bg;
    ctx.fill();
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    const pad = PREVIEW_PAD;
    const innerW = Math.max(10, sp.preW - pad * 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = c.font;

    // 第一行报总字数（触发词拼没拼上，看长度变化最直观）
    const text = mergedTextOf(node);
    const tn = textListOf(node).length;
    ctx.fillStyle = c.muted;
    ctx.fillText(
        clipText(ctx, `最终文本预览 · ${text.length} 字${tn ? ` · 文本列表 ${tn} 条` : ""}`, innerW),
        sp.preX + pad,
        y0 + pad + 6
    );

    let bodyTop = y0 + pad + PREVIEW_TITLE_H + 4;

    // 第二行固定显示"本次拼进去的触发词"。正文很长时末尾会被截断，
    // 而用户最想确认的恰恰是触发词有没有生效，所以单独拎出来用强调色钉在这儿。
    const trig = triggerListOf(node);
    if (trig) {
        ctx.fillStyle = c.accent;
        ctx.fillText(
            clipText(ctx, `触发词：${trig}`, innerW),
            sp.preX + pad,
            bodyTop + PREVIEW_LINE_H / 2
        );
    } else {
        ctx.fillStyle = c.muted;
        ctx.fillText("触发词：无", sp.preX + pad, bodyTop + PREVIEW_LINE_H / 2);
    }
    bodyTop += PREVIEW_LINE_H;

    if (!text.trim()) {
        ctx.fillStyle = c.muted;
        ctx.fillText("（还没写内容）", sp.preX + pad, bodyTop + PREVIEW_LINE_H / 2);
        ctx.restore();
        return;
    }

    const maxLines = Math.max(0, Math.floor((y0 + h - pad - bodyTop) / PREVIEW_LINE_H));
    if (maxLines <= 0) {
        ctx.restore();
        return;
    }
    const all = wrapText(ctx, text, innerW, 9999);
    const shown = all.slice(0, maxLines);
    if (all.length > shown.length && shown.length) {
        shown[shown.length - 1] = clipText(ctx, shown[shown.length - 1] + " …", innerW);
    }
    ctx.fillStyle = c.text;
    let ly = bodyTop + PREVIEW_LINE_H / 2;
    for (const s of shown) {
        ctx.fillText(s, sp.preX + pad, ly);
        ly += PREVIEW_LINE_H;
    }
    ctx.restore();
}

// -----------------------------------------------------------------------------
// 交互
// -----------------------------------------------------------------------------
function openLoraMenu(e, widget, api) {    const build = (list) => {
        const cur = parseState(widget.value).lora;
        const mark = (v) => (v === cur ? "✓ " : "");
        const items = [{ content: `${mark("None")}None`, value: "None" }];
        const { root, groups } = groupFiles(list);
        for (const f of root) items.push({ content: mark(f) + shortName(f), value: f });
        for (const [dir, files] of groups) {
            items.push({ content: `📁 ${dir}  (${files.length})`, disabled: true });
            for (const f of files) items.push({ content: "    " + mark(f.value) + f.label, value: f.value });
        }
        const Menu = globalThis.LiteGraph?.ContextMenu || globalThis.ContextMenu;
        if (!Menu) {
            console.warn("[小岚lora阵列] 找不到 ContextMenu 组件");
            return;
        }
        new Menu(items, {
            event: e,
            title: "选择 LoRA",
            callback: (v) => {
                const name = typeof v === "string" ? v : v?.value ?? v?.content;
                if (name == null) return;
                api.patch(widget, { lora: String(name) });
            },
        });
    };
    if (Array.isArray(loraCache)) build(loraCache);
    else fetchLoraList().then(build);
}

function cycleLora(widget, dir, api) {
    const items = ["None", ...(loraCache || [])];
    const s = parseState(widget.value);
    const i = items.indexOf(s.lora);
    api.patch(widget, { lora: items[((i < 0 ? 0 : i) + dir + items.length) % items.length] });
}

function openTriggerInput(px, py, widget, api) {
    if (document.getElementById("xiaolan-trigger-input")) return;
    const s = parseState(widget.value);
    const input = document.createElement("input");
    input.id = "xiaolan-trigger-input";
    input.type = "text";
    input.value = s.t;
    input.placeholder = "触发词，Enter 保存 / Esc 取消";
    const cx = px ?? window.innerWidth / 2;
    const cy = py ?? window.innerHeight / 2;
    Object.assign(input.style, {
        position: "fixed",
        left: clamp(cx - 110, 8, window.innerWidth - 240) + "px",
        top: clamp(cy - 13, 8, window.innerHeight - 40) + "px",
        width: "220px",
        zIndex: 100000,
        background: T().bg,
        color: T().text,
        border: "1px solid " + T().accent,
        borderRadius: "6px",
        padding: "5px 8px",
        fontSize: "12px",
        outline: "none",
        boxShadow: "0 3px 12px rgba(0,0,0,0.45)",
    });
    let done = false;
    let onDocDown = null;
    const commit = (save) => {
        if (done) return;
        done = true;
        if (save) api.patch(widget, { t: input.value.trim() });
        if (onDocDown) document.removeEventListener("pointerdown", onDocDown, true);
        input.remove();
    };
    input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit(true);
        else if (ev.key === "Escape") commit(false);
    });
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.body.appendChild(input);

    // 创建它的那次 pointerdown 尚未结束，立即 focus 会被 pointerup 打掉，故延后一帧
    requestAnimationFrame(() => {
        setTimeout(() => {
            if (done) return;
            input.focus();
            input.select();
            onDocDown = (ev) => {
                if (!input.contains(ev.target)) commit(true);
            };
            document.addEventListener("pointerdown", onDocDown, true);
        }, 0);
    });
}

/**
 * 文本列表条目的编辑弹窗。field = "title" | "text"。
 * 用的是画布上的浮动 <input>（和触发词编辑同一套做法）：
 *   · 不受节点缩放影响，输入法、选中、复制粘贴都是原生的；
 *   · Enter 保存 / Esc 取消 / 点到别处自动保存；
 *   · 同一时刻只允许存在一个，避免多个弹窗互相抢焦点。
 */
function openTextInput(px, py, widget, api, field) {
    const ID = "xiaolan-text-input";
    if (document.getElementById(ID)) return;
    const s = parseTextState(widget.value);
    const isTitle = field === "title";
    const input = document.createElement("input");
    input.id = ID;
    input.type = "text";
    input.value = isTitle ? s.title : s.text;
    input.placeholder = isTitle
        ? "标题 / 备注（只是给自己看的，不参与输出）"
        : "文本内容（会拼进合并输出）";
    const W = isTitle ? 240 : 340;
    const cx = px ?? window.innerWidth / 2;
    const cy = py ?? window.innerHeight / 2;
    Object.assign(input.style, {
        position: "fixed",
        left: clamp(cx - 20, 8, Math.max(8, window.innerWidth - W - 8)) + "px",
        top: clamp(cy - 13, 8, window.innerHeight - 40) + "px",
        width: W + "px",
        zIndex: 100000,
        background: T().bg,
        color: T().text,
        border: "1px solid " + (isTitle ? TEXT_COLOR : T().accent),
        borderRadius: "6px",
        padding: "5px 8px",
        fontSize: "12px",
        outline: "none",
        boxShadow: "0 3px 12px rgba(0,0,0,0.45)",
    });
    let done = false;
    let onDocDown = null;
    const commit = (save) => {
        if (done) return;
        done = true;
        if (save) api.patchText(widget, { [field]: input.value.trim() });
        if (onDocDown) document.removeEventListener("pointerdown", onDocDown, true);
        input.remove();
    };
    input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit(true);
        else if (ev.key === "Escape") commit(false);
    });
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.body.appendChild(input);

    // 创建它的那次 pointerdown 尚未结束，立即 focus 会被 pointerup 打掉，故延后一帧
    requestAnimationFrame(() => {
        setTimeout(() => {
            if (done) return;
            input.focus();
            input.select();
            onDocDown = (ev) => {
                if (!input.contains(ev.target)) commit(true);
            };
            document.addEventListener("pointerdown", onDocDown, true);
        }, 0);
    });
}

/** 权重拖动：用 document 级监听，指针移出本行也不会丢事件 */
function beginWeightDrag(widget, e, api) {
    const startX = e.clientX ?? e.pageX ?? 0;
    const startW = parseState(widget.value).w;
    const scale = canvasScale();
    widget._dragging = true;
    const move = (ev) => {
        const dx = ((ev.clientX ?? 0) - startX) / scale;
        if (Math.abs(dx) < 2) return;
        const next = round2(clamp(startW + dx * 0.01, -10, 10));
        if (parseState(widget.value).w !== next) api.patch(widget, { w: next });
    };
    const up = () => {
        widget._dragging = false;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        setDirty();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
}

// -----------------------------------------------------------------------------
// 行控件
// -----------------------------------------------------------------------------
function makeRowWidget(index, api, prevValue) {
    const widget = {
        name: `xl_row_${index}`,
        type: "xiaolan_lora_row",
        _index: index,
        _dragging: false,
        value: prevValue || JSON.stringify(DEFAULT_STATE),
        // ★ 顶层 serialize:false 不能省。前端的 serialize()/configure() 判断的是
        //   widget.serialize（顶层），而 options.serialize 只影响提交后端的负载 ——
        //   两者不是一回事。只写 options 的话，自绘控件的值会被存进工作流，
        //   把后面的控件顶到高位下标上，加载回来就错位了（实测踩过）。
        serialize: false,
        options: { serialize: false }, // 数据统一走 rows_data
        serializeValue() {
            return null;
        },
        computeSize(width) {
            return [Math.max(width || NODE_W, 200), ROW_H];
        },
        draw(ctx, node, width, y) {
            try {
                drawRow(ctx, node, widget, width, y);
            } catch (err) {
                console.error("[小岚lora阵列] 绘制行失败:", err);
            }
        },
        mouse(e, pos, node) {
            pinStartY(node);
            const z = zones(node.size[0], reserveOf(node));
            const x = pos[0];
            const kind = evKind(e);
            if (kind !== "down") return true; // 悬停由 document 级跟踪处理

            // 从右往左判断热区（del 最右，sw 最左）
            if (x >= z.delX) {
                api.removeRow(index);
                return true;
            }
            if (x >= z.trigX) {
                const [px, py] = canvasToScreen(node, z.trigX + 8, pos[1] - 13);
                openTriggerInput(px, py, widget, api);
                return true;
            }
            if (x >= z.weightX) {
                const w = parseState(widget.value).w;
                if (x < z.minusX + 26) {
                    api.patch(widget, { w: roundStep(w - 0.05, 0.05) });
                    return true;
                }
                if (x >= z.plusX) {
                    api.patch(widget, { w: roundStep(w + 0.05, 0.05) });
                    return true;
                }
                beginWeightDrag(widget, e, api);
                return true;
            }
            if (x >= z.loraX) {
                if (x < z.loraX + ARROW_W) cycleLora(widget, -1, api);
                else if (x >= z.loraX + z.loraW - ARROW_W) cycleLora(widget, 1, api);
                else openLoraMenu(e, widget, api);
                return true;
            }
            if (x >= z.swX) {
                api.patch(widget, { e: parseState(widget.value).e === false });
                return true;
            }
            return true;
        },
    };
    return widget;
}

/**
 * 文本列表的一行控件：[ 开关 ] [ 标题(备注) ] [ 正文 ] [ ✕ ]
 * 数据统一走 texts_data，所以这个控件自己不序列化（原因见 makeRowWidget 里的注释）。
 */
function makeTextWidget(index, api, prevValue) {
    const widget = {
        name: `xl_text_${index}`,
        type: "xiaolan_text_row",
        _index: index,
        value: prevValue || JSON.stringify(DEFAULT_TEXT),
        // ★ 顶层 serialize:false 不能省（前端的 serialize()/configure() 判的是顶层字段）
        serialize: false,
        options: { serialize: false },
        serializeValue() {
            return null;
        },
        computeSize(width) {
            return [Math.max(width || NODE_W, 200), ROW_H];
        },
        draw(ctx, node, width, y) {
            try {
                drawTextRow(ctx, node, widget, width, y);
            } catch (err) {
                console.error("[小岚lora阵列] 绘制文本行失败:", err);
            }
        },
        mouse(e, pos, node) {
            pinStartY(node);
            if (evKind(e) !== "down") return true; // 悬停由 document 级跟踪处理

            // 只在这一行自己的框里生效：纵向越界直接忽略
            const wy = typeof widget.y === "number" ? widget.y : null;
            if (wy != null && (pos[1] < wy - 1 || pos[1] > wy + ROW_H + 1)) return true;

            const z = textZones(node.size[0], reserveOf(node));
            const x = pos[0];
            if (x < z.m || x > z.right) return true; // 横向出框也不响应

            const kind = textZoneAt(x, z);
            if (kind === "del") {
                api.removeText(index);
            } else if (kind === "title") {
                const [px, py] = canvasToScreen(node, z.titleX + 12, pos[1] - 13);
                openTextInput(px, py, widget, api, "title");
            } else if (kind === "body") {
                const [px, py] = canvasToScreen(node, z.bodyX + 12, pos[1] - 13);
                openTextInput(px, py, widget, api, "text");
            } else if (kind === "sw") {
                api.patchText(widget, { e: parseTextState(widget.value).e === false });
            }
            return true;
        },
    };
    return widget;
}

/**
 * 文本列表的说明行：左「文本列表 · N 条 · 标题仅作备注」右「✕ 删除末条」。
 * 一条都没有时整个控件 hidden，不占高度（点顶部「＋ 添加文本」才会出现）。
 * 要闭包捕获 node：computeSize 里拿不到节点，只有宽度。
 */
function makeTextHeaderWidget(node) {
    return {
        name: "xiaolan_text_header",
        type: "xiaolan_text_header",
        value: null,
        // ★ 顶层 serialize:false 不能省（前端的 serialize()/configure() 判的是顶层字段）
        serialize: false,
        options: { serialize: false },
        serializeValue() {
            return null;
        },
        computeSize(width) {
            const n = node?.__xiaolan?.texts?.length ?? 0;
            return [Math.max(width || NODE_W, 200), n ? TEXT_HEADER_H : 0];
        },
        draw(ctx, node, width, y) {
            try {
                drawTextHeader(ctx, node, width, y);
            } catch (e) {
                console.error("[小岚lora阵列] 绘制文本列表说明行失败:", e);
            }
        },
        mouse(e, pos, node) {
            if (evKind(e) !== "down") return true;
            const th = node.__xiaolan?.textHeader;
            const hy = th && typeof th.y === "number" ? th.y : null;
            // 「只在框中生效」：纵向越界 → 什么都不做
            if (hy != null && (pos[1] < hy - 1 || pos[1] > hy + TEXT_HEADER_H + 1)) return true;
            const btn = textDelLastZones(node.size[0], reserveOf(node));
            if (pos[0] >= btn.x && pos[0] <= btn.x + btn.w && pos[1] >= hy + 1 && pos[1] <= hy + TEXT_HEADER_H - 1) {
                node.__xiaolan.api.removeLastText();
            }
            return true;
        },
    };
}

// -----------------------------------------------------------------------------
// 节点状态维护
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 提示词框（仅"提示词版"节点）
//   直接用前端原生的多行 STRING 控件（DOM <textarea>），我们只做三件事：
//     · 把它排到最后（添加按钮下方），不隐藏
//     · 统一成与节点其它元素一致的外观
//     · 告诉布局它该占多高（PROMPT_H）
//   标签不另外画（DOM 层会盖住画布），靠 placeholder 自解释。
// -----------------------------------------------------------------------------
function stylePromptWidget(w, minH) {
    if (!w) return;
    // 标签交给自绘的 xiaolan_prompt_label 控件（画布上那一条），这里留空避免重复
    w.label = " ";
    w.hidden = false;
    const el = w.element;
    if (el) {
        if (el.tagName === "TEXTAREA") {
            el.placeholder = "在这里写提示词…";
            el.spellcheck = false;
        }
        const c = T();
        Object.assign(el.style, {
            background: c.bg,
            color: c.text,
            border: "1px solid " + c.border,
            borderRadius: "7px",
            padding: "7px 9px",
            fontSize: "12px",
            lineHeight: "16px",
            fontFamily: "inherit",
            resize: "none",
            outline: "none",
            boxSizing: "border-box",
            display: "block",
        });
        const wrap = el.parentElement;
        if (wrap) {
            Object.assign(wrap.style, {
                padding: "0",
                margin: "0",
                background: "transparent",
                border: "none",
                boxSizing: "border-box",
            });
        }
    }
    // ★ 让文本框"可伸缩"：用户把节点往下拉，多出来的空间全部灌进这个框。
    //
    // 前端每帧 drawNode 都会调 node.arrange() → _arrangeWidgets()，那里按控件能力分两路：
    //   有 computeSize()      → 固定高度（computedHeight = computeSize()[1] + 4）
    //   有 computeLayoutSize() → 可伸缩，minHeight 起步，再用 distributeSpace() 把
    //                           bodyHeight 里剩下的空间分给它（maxHeight 不设 = 不封顶）
    // DOM 控件的高度就是取 computedHeight（见 DomWidgets.vue），所以：
    //   · 这里绝不能给 computeSize —— 那会把框钉死在 96px（之前"拉高不跟随"就是这个原因）；
    //   · 报 minHeight 就够，多出来的空间前端会自动补。
    //
    // 注意 maxHeight 必须留 undefined（= 不封顶）。给数字的话，节点拉过头时框就不再长，
    // 底下会重新出现空白。
    w.computeLayoutSize = function () {
        return { minHeight: minH || PROMPT_H, maxHeight: undefined, minWidth: 0 };
    };
}

/**
 * 顶部行控件：左「总开关」右「＋ 添加 LoRA」（一个控件画两半，热区按 x 分）
 */
function makeHeaderWidget() {
    return {
        name: "xiaolan_header",
        type: "xiaolan_header",
        value: null,
        // ★ 顶层 serialize:false 不能省。前端的 serialize()/configure() 判断的是
        //   widget.serialize（顶层），而 options.serialize 只影响提交后端的负载 ——
        //   两者不是一回事。只写 options 的话，自绘控件的值会被存进工作流，
        //   把后面的控件顶到高位下标上，加载回来就错位了（实测踩过）。
        serialize: false,
        options: { serialize: false },
        serializeValue() {
            return null;
        },
        computeSize(width) {
            return [Math.max(width || NODE_W, 200), HEADER_H];
        },
        draw(ctx, node, width, y) {
            try {
                drawHeader(ctx, node, width, y);
            } catch (e) {
                console.error("[小岚lora阵列] 绘制顶部行失败:", e);
            }
        },
        mouse(e, pos, node) {
            if (evKind(e) !== "down") return true;
            const st = node.__xiaolan;
            if (!st) return true;
            // 「按钮只在框中生效」：先在纵向上确认点的是顶部这一行，
            // 再要求 x 严格落在某个盒子内；落在盒子之间的缝隙里 → 什么都不做。
            const hy = typeof node.__xiaolan?.header?.y === "number" ? node.__xiaolan.header.y : null;
            if (hy != null && (pos[1] < hy - 1 || pos[1] > hy + HEADER_H + 1)) return true;
            const z = headerZones(node.size[0], reserveOf(node), hasTextList(node));
            const x = pos[0];
            if (x < z.m || x > z.right) return true;
            if (z.textW && x >= z.textX && x <= z.textX + z.textW) {
                st.api.addText();
                return true;
            }
            if (x >= z.addX && x <= z.addX + z.addW) {
                st.api.addRow();
                return true;
            }
            if (x >= z.toggleX && x <= z.toggleX + z.toggleW) {
                st.api.toggle();
                return true;
            }
            return true;
        },
    };
}

/**
 * 超过独立端口数时的说明行（不需要时高度为 0，等于不存在）。
 * 要闭包捕获 node：computeSize 里拿不到节点，只有宽度。
 */
function makeHintWidget(node) {
    return {
        name: "xiaolan_hint",
        type: "xiaolan_hint",
        value: null,
        // ★ 顶层 serialize:false 不能省。前端的 serialize()/configure() 判断的是
        //   widget.serialize（顶层），而 options.serialize 只影响提交后端的负载 ——
        //   两者不是一回事。只写 options 的话，自绘控件的值会被存进工作流，
        //   把后面的控件顶到高位下标上，加载回来就错位了（实测踩过）。
        serialize: false,
        options: { serialize: false },
        serializeValue() {
            return null;
        },
        computeSize(width) {
            const n = node?.__xiaolan?.rows?.length ?? 0;
            return [Math.max(width || NODE_W, 200), n >= MAX_OUT ? HINT_H : 0];
        },
        draw(ctx, node, width, y) {
            try {
                drawHint(ctx, node, width, y);
            } catch (e) {
                /* ignore */
            }
        },
        mouse() {
            return true;
        },
    };
}

/**
 * 提示词框上方那一行：中间是说明文字，两端给「文本输入 / 文本输出」端口让位。
 * 纯画布控件，不参与序列化。
 */
function makePromptLabelWidget() {
    return {
        name: "xiaolan_prompt_label",
        type: "xiaolan_prompt_label",
        value: null,
        // ★ 顶层 serialize:false 不能省。前端的 serialize()/configure() 判断的是
        //   widget.serialize（顶层），而 options.serialize 只影响提交后端的负载 ——
        //   两者不是一回事。只写 options 的话，自绘控件的值会被存进工作流，
        //   把后面的控件顶到高位下标上，加载回来就错位了（实测踩过）。
        serialize: false,
        options: { serialize: false },
        serializeValue() {
            return null;
        },
        computeSize(width) {
            return [Math.max(width || NODE_W, 200), HINT_H];
        },
        draw(ctx, node, width, y) {
            const c = T();
            ctx.save();
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.font = c.font;
            ctx.fillStyle = c.muted;

            let x = M + 2;
            // 左边有「文本输入」端口标签，量准它的宽度再让位，避免压在一起
            const inp = (node.inputs || []).find((i) => i.name === "text_in");
            if (inp) {
                const LF = globalThis.LiteGraph || {};
                ctx.font = `${LF.NODE_TEXT_SIZE || 14}px ${LF.NODE_FONT || "sans-serif"}`;
                const lw = ctx.measureText(inp.label || inp.name || "").width;
                ctx.font = c.font;
                x += lw + 22;
            }
            // 说明文字只占左半栏：右半栏上方是预览框，别压过去
            const sp = promptSplit(node);
            const maxW = Math.max(sp.boxW - x - 8, 80);
            ctx.fillText(
                clipText(ctx, "提示词 · ⇔ 拖右侧分隔条可调宽度", maxW),
                x,
                y + HINT_H / 2 + 1
            );
            ctx.restore();
            // 预览框：靠 promptW 的真实几何定位，紧跟提示词框
            drawPromptPreview(ctx, node);
        },
        mouse() {
            return true;
        },
    };
}

function reorder(node) {
    const st = node.__xiaolan;
    const declared = node.widgets.filter((w) => DECLARED.has(w.name));
    // 顺序：声明的隐藏控件 → 顶部行(总开关+两个添加按钮) → 各行 → 超行提示
    //       → 文本列表说明行 → 文本行 → 提示词说明 → 提示词框
    // 提示词框是带序列化值的真实控件，挪到数组末尾不影响 widgets_values 顺序
    // （它本来就是最后一个可序列化的控件）
    //
    // ★ 说明行不用时直接 hidden，而不是"高度返回 0"：
    //   前端布局对返回 0 的控件照样 `height = 0 + 4`，会凭空多出 4px 间隙，
    //   和我们在 computeSize 里跳过它的算法对不上 → 文本框会比预期高 4px。
    //   hidden 是两边都认的"不存在"。
    if (st.hint) st.hint.hidden = st.rows.length < MAX_OUT;
    if (st.textHeader) st.textHeader.hidden = !(st.texts && st.texts.length);
    node.widgets = [
        ...declared,
        ...(st.header ? [st.header] : []),
        ...st.rows,
        ...(st.hint ? [st.hint] : []),
        ...(st.textHeader ? [st.textHeader] : []),
        ...(st.texts || []),
        ...(st.promptLabel ? [st.promptLabel] : []),
        ...(st.promptW ? [st.promptW] : []),
    ];
}

function syncOut(node) {
    const st = node.__xiaolan;
    if (!st?.dataW) return;
    st.dataW.value = JSON.stringify(st.rows.map((w) => parseState(w.value)));
}

/** 文本列表 → texts_data（后端只读这一个字段） */
function syncTexts(node) {
    const st = node.__xiaolan;
    if (!st?.textsW) return;
    st.textsW.value = JSON.stringify((st.texts || []).map((w) => parseTextState(w.value)));
}

function refresh(node) {
    pinStartY(node);
    layoutOutputs(node);
    try {
        const st = node.__xiaolan;
        const sz = node.computeSize([node.size[0], node.size[1]]) || [...node.size];
        const wantW = Math.max(sz[0], NODE_W);
        // 高度：用户手动拉出来的那一截是留给提示词框的，换行数时要留住。
        // userExtra 由 onResize 维护（只记外部改的高度，不记我们自己 setSize 的），
        // 所以"自动高度变了"不会被误当成"用户拉伸"，也不会逐次累积误差。
        const extra = Math.max(0, (st && st.userExtra) || 0);
        if (st) {
            st.autoH = sz[1];
            st._selfResize = true;
            node.setSize([wantW, sz[1] + extra]);
            st._selfResize = false;
        } else {
            node.setSize([wantW, sz[1]]);
        }
    } catch (e) {
        /* ignore */
    }
    setDirty();
}

function renumber(node) {
    node.__xiaolan.rows.forEach((w, i) => {
        w._index = i + 1;
        w.name = `xl_row_${i + 1}`;
    });
}

function renumberTexts(node) {
    (node.__xiaolan.texts || []).forEach((w, i) => {
        w._index = i + 1;
        w.name = `xl_text_${i + 1}`;
    });
}

/** 文本列表整表替换（复用已有控件，避免闪烁）；空数组 = 整个区块收起 */
function setTexts(node, texts) {
    const st = node.__xiaolan;
    if (!st || !st.texts) return;
    while (st.texts.length > texts.length) {
        const w = st.texts.pop();
        const i = node.widgets.indexOf(w);
        if (i >= 0) node.widgets.splice(i, 1);
    }
    while (st.texts.length < texts.length) {
        st.texts.push(makeTextWidget(st.texts.length + 1, st.api, ""));
    }
    st.texts.forEach((w, i) => {
        w.value = JSON.stringify({ ...DEFAULT_TEXT, ...(texts[i] || {}) });
    });
    renumberTexts(node);
    reorder(node);
    syncTexts(node);
    refresh(node);
}

/** 读取初始文本列表：只认 texts_data（旧工作流没有这个字段 → 空列表） */
function readInitialTexts(node) {
    return parseTexts(node.__xiaolan?.textsW?.value);
}

/** 用给定的行数据整体替换（会复用已有控件，避免闪烁） */
function setRows(node, rows) {
    const st = node.__xiaolan;
    while (st.rows.length > rows.length) {
        const w = st.rows.pop();
        const i = node.widgets.indexOf(w);
        if (i >= 0) node.widgets.splice(i, 1);
    }
    while (st.rows.length < rows.length) {
        st.rows.push(makeRowWidget(st.rows.length + 1, st.api, ""));
    }
    st.rows.forEach((w, i) => {
        w.value = JSON.stringify({ ...DEFAULT_STATE, ...(rows[i] || {}) });
    });
    renumber(node);
    reorder(node);
    syncOut(node);
    refresh(node);
}

/** 读取初始行：优先 rows_data，其次旧版 row_1..row_10 迁移 */
function readInitialRows(node) {
    const rows = parseRows(node.__xiaolan?.dataW?.value);
    if (rows.length) return rows;

    const legacy = [];
    for (let i = 1; i <= LEGACY_SLOTS; i++) {
        const wd = (node.widgets || []).find((x) => x.name === `row_${i}`);
        legacy.push(parseState(wd ? wd.value : ""));
    }
    let n = 0;
    try {
        n = parseInt(node.__xiaolan?.countW?.value ?? 0, 10) || 0;
    } catch (e) {
        n = 0;
    }
    if (n > 0) {
        return legacy.slice(0, Math.min(n, LEGACY_SLOTS)).map((r) => ({ ...DEFAULT_STATE, ...r }));
    }
    const kept = legacy.filter((r) => !isNone(r.lora) || r.t);
    return kept.length ? kept : [{ ...DEFAULT_STATE }];
}

// -----------------------------------------------------------------------------
// 升级节点（幂等）
// -----------------------------------------------------------------------------
/**
 * 控件值回填的"头 / 尾"对齐。
 *
 * 前端原生 configure() 是按【第几个可序列化控件】的顺序读 widgets_values 的，
 * 一旦工作流是旧版本存下来的（控件个数和现在对不上），后面的值就整体错位 ——
 * 用户之前报的"提示词框里出现一串乱码"就是这么来的。我们自己存的格式是紧凑数组，
 * 所以只有"长度不同"这一种情况需要特殊照顾。
 *
 * 两条稳定规律：
 *   1) 头段：toggle / lora_count / row_1..row_10 / rows_data 这 13 项，
 *      从 v6 起就固定在数组最前面、顺序不变；
 *   2) 尾段：后加的控件一律追加在头段之后，prompt_text 永远排在最后一个可序列化位置，
 *      所以越靠后的值越要靠"从右往左"去认。
 * 于是：头段照下标对齐，尾段按剩余长度分支（1 项 = 只有提示词框，2 项 = 文本列表 + 提示词框），
 * 更长的（旧 bug 留下的带空洞稀疏数组）只救提示词框，其余走各自默认值。
 *
 * 返回 true 表示处理过（调用方用它决定要不要跳过原生逻辑，这里不跳，多跑一遍更保险 —— 幂等）。
 */
function restoreWidgetValues(node, vals) {
    const mine = (node.widgets || []).filter((wd) => wd && wd.serialize !== false);
    if (!Array.isArray(vals) || !mine.length) return false;

    const nHead = Math.min(DECL_HEAD, vals.length);
    for (let i = 0; i < nHead; i++) {
        const v = vals[i];
        if (v === null || v === undefined) continue;
        mine[i].value = v;
    }

    const rest = vals.length - DECL_HEAD;
    const promptW = node.__xiaolan?.promptW;
    const textsW = node.__xiaolan?.textsW;
    if (rest <= 0) return true;

    if (rest === 1) {
        if (promptW && vals[DECL_HEAD] != null) promptW.value = vals[DECL_HEAD];
        return true;
    }
    if (rest === 2) {
        if (textsW && vals[DECL_HEAD] != null) textsW.value = vals[DECL_HEAD];
        if (promptW && vals[DECL_HEAD + 1] != null) promptW.value = vals[DECL_HEAD + 1];
        return true;
    }

    // 旧格式（带空洞的稀疏数组）：只认"最后一个非空项 = 提示词框"
    let last = vals.length - 1;
    while (last >= 0 && (vals[last] === null || vals[last] === undefined)) last -= 1;
    if (promptW && last >= 0 && vals[last] != null) promptW.value = vals[last];
    return true;
}

function upgradeNode(node) {
    if (!node || node.__xiaolan_ready || node.__xiaolan_busy) return false;
    if (!NODE_NAMES.has(node.type) && !NODE_NAMES.has(node.comfyClass)) return false;
    node.__xiaolan_busy = true;
    let ok = false;
    try {
        const byName = (n) => (node.widgets || []).find((w) => w.name === n);
        const toggle = byName("toggle");
        const countW = byName("lora_count");
        const dataW = byName("rows_data");
        if (!countW || !dataW) {
            console.error(
                "[小岚lora阵列] 后端缺少 rows_data 输入，说明 ComfyUI 还在跑旧版 nodes.py。" +
                "请先重启 ComfyUI（后端），再刷新浏览器页面。"
            );
            return false;
        }

        // 提示词版节点：prompt_text 是原生多行文本框（DOM 控件），
        // 不隐藏，而是排到最后一行下面，并统一它的外观
        const promptMode = isPromptNode(node);
        const promptW = promptMode ? byName("prompt_text") : null;
        if (promptMode && !promptW) {
            console.error(
                "[小岚lora阵列] 后端缺少 prompt_text 输入，说明 ComfyUI 还在跑旧版 nodes.py。" +
                "请先重启 ComfyUI（后端），再刷新浏览器页面。"
            );
            return false;
        }
        // 文本列表（v7.3）：同样是"界面自动维护的隐藏字段"，藏在界面上不显示
        const textsW = promptMode ? byName("texts_data") : null;
        if (promptMode && !textsW) {
            console.error(
                "[小岚lora阵列] 后端缺少 texts_data 输入，说明 ComfyUI 还在跑旧版 nodes.py。" +
                "请先重启 ComfyUI（后端），再刷新浏览器页面。"
            );
            return false;
        }

        if (toggle) {
            // 原生控件藏起来，改由顶部的 xiaolan_header 自绘（要和添加按钮排一行）。
            // 隐藏不影响它进提交负载，值仍然照传。
            toggle.label = "总开关";
            toggle.hidden = true;
            toggle.serializeValue = () => toggle.value;
        }
        countW.hidden = true;
        dataW.hidden = true;
        if (textsW) textsW.hidden = true;
        for (let i = 1; i <= LEGACY_SLOTS; i++) {
            const r = byName(`row_${i}`);
            if (r) r.hidden = true;
        }
        // 提示词框：布局分到的高度 = textarea 想要的高度 + margin*2。
        // margin 是 DOM 控件自己的属性（默认 10），动态读一下，
        // 免得将来前端改了默认值、我们这边还按老数字算，框就高矮不对。
        let promptH = PROMPT_H;
        if (promptW) {
            const mm = typeof promptW.margin === "number" ? promptW.margin * 2 : PROMPT_CHROME_FALLBACK;
            promptH = PROMPT_BOX_H + mm;
            stylePromptWidget(promptW, promptH);
        }

        // zones() 暴露出来：控制台调试和自动化测试直接读真实几何，不用复刻一遍坐标算法
        node.__xiaolan = {
            rows: [],
            texts: [], // 文本列表（仅提示词版，空数组表示还没加过）
            dataW,
            countW,
            textsW: textsW || null,
            promptW,
            promptMode,
            toggle: toggle || null,
            header: makeHeaderWidget(),
            hint: makeHintWidget(node),
            textHeader: promptMode ? makeTextHeaderWidget(node) : null,
            // 下面两个只有提示词版才有；由 reorder 放进数组，不用手动 push
            promptLabel: promptMode ? makePromptLabelWidget() : null,
            hover: null,
            autoH: undefined, // 上一次算出的自动高度
            userExtra: 0, // 用户手动拉出来、要留给提示词框的高度
            _selfResize: false, // 我们自己 setSize 时置位，用于区分内外
            zones: () => zones(node.size[0], reserveOf(node)),
            textZones: () => textZones(node.size[0], reserveOf(node)),
            headerZones: () => headerZones(node.size[0], reserveOf(node), hasTextList(node)),
            textDelLastZones: () => textDelLastZones(node.size[0], reserveOf(node)),
            promptH: promptH, // 报给布局的起点高度（= PROMPT_BOX_H + margin*2）
            promptBoxH: PROMPT_BOX_H, // 没被拉伸时 textarea 的视觉高度
            splitDragging: false, // 分隔条正在被拖
            // 分隔条相关的真实几何，给控制台调试和自动化测试用
            splitRatio: () => splitRatioOf(node),
            setSplitRatio: (r) => {
                setSplitRatio(node, r);
                setDirty();
            },
            splitX: () => splitXOf(node),
            splitHitAt: (lx, ly) => splitHitAt(node, lx, ly),
        };
        const api = {
            patch(widget, fields) {
                const s = parseState(widget.value);
                Object.assign(s, fields);
                widget.value = JSON.stringify(s);
                syncOut(node);
                setDirty();
            },
            addRow() {
                const st = node.__xiaolan;
                if (st.rows.length >= MAX_ROWS) return;
                st.rows.push(makeRowWidget(st.rows.length + 1, st.api, JSON.stringify(DEFAULT_STATE)));
                renumber(node);
                reorder(node);
                syncOut(node);
                refresh(node);
            },
            /** 总开关（不传参 = 取反） */
            toggle(v) {
                const lg = node.__xiaolan?.toggle;
                if (!lg) return;
                lg.value = v === undefined ? !lg.value : !!v;
                setDirty();
            },
            removeRow(index) {
                const st = node.__xiaolan;
                if (index < 1 || index > st.rows.length) return;
                const [w] = st.rows.splice(index - 1, 1);
                const k = node.widgets.indexOf(w);
                if (k >= 0) node.widgets.splice(k, 1);
                if (!st.rows.length) st.rows.push(makeRowWidget(1, st.api, JSON.stringify(DEFAULT_STATE)));
                renumber(node);
                reorder(node);
                syncOut(node);
                refresh(node);
            },

            // ---------- 文本列表 ----------
            patchText(widget, fields) {
                const s = parseTextState(widget.value);
                Object.assign(s, fields);
                widget.value = JSON.stringify(s);
                syncTexts(node);
                setDirty();
            },
            addText() {
                const st = node.__xiaolan;
                if (!st.texts) return;
                if (st.texts.length >= MAX_TEXTS) return;
                st.texts.push(makeTextWidget(st.texts.length + 1, st.api, JSON.stringify(DEFAULT_TEXT)));
                renumberTexts(node);
                reorder(node);
                syncTexts(node);
                refresh(node);
            },
            removeText(index) {
                const st = node.__xiaolan;
                if (!st.texts || index < 1 || index > st.texts.length) return;
                const [w] = st.texts.splice(index - 1, 1);
                const k = node.widgets.indexOf(w);
                if (k >= 0) node.widgets.splice(k, 1);
                renumberTexts(node);
                reorder(node);
                syncTexts(node);
                refresh(node);
            },
            /** 删掉最后一条（说明行右侧那个「✕ 删除末条」按钮） */
            removeLastText() {
                const st = node.__xiaolan;
                if (!st.texts || !st.texts.length) return;
                api.removeText(st.texts.length);
            },
        };
        node.__xiaolan.api = api;

        // 尺寸：只累计可见控件高度（前端默认按端口数算会虚高虚窄）
        //
        // ★ 这里的口径必须和前端 _arrangeWidgets() 完全一致，否则两边差几像素、
        //   提示词框就会在"刚好"和"多 10px"之间跳：
        //     固定控件 → computeSize()[1] + 4
        //     可伸缩控件（提示词框）→ 只算基准高度，不占那 4px，因为它的高度是
        //        distributeSpace 用「节点高 - 起点 - 所有固定控件」算出来的。
        //   对齐后：节点没被拉伸时，文本框正好 PROMPT_BOX_H 高（多出来的恰好为 0）。
        node.computeSize = function (out) {
            const w = Math.max(NODE_W, (out && out[0]) || this.size?.[0] || NODE_W);
            const pw = this.__xiaolan?.promptW;
            let h = TOP_Y;
            for (const wd of this.widgets || []) {
                if (!wd || wd.hidden) continue;
                if (wd === pw) {
                    // 可伸缩控件：按基准高度计入，不加 ROW_GAP
                    h += this.__xiaolan?.promptH || PROMPT_H;
                    continue;
                }
                let wh = 24;
                try {
                    if (typeof wd.computeSize === "function") {
                        const r = wd.computeSize(w);
                        // 原样采用控件自报的高度。不要"至少 20"这种补偿 ——
                        // 前端就是原样用 computeSize()[1]，我们放大几像素，
                        // 自动高度就比真实布局多出几像素，最后全落在文本框的高矮上。
                        if (r && typeof r[1] === "number") wh = r[1];
                    }
                } catch (e) {
                    /* ignore */
                }
                // 这里的 ROW_GAP 必须等于前端 _arrangeWidgets 里那个硬编码的 4，
                // 否则自动高度和实际布局会错位。改 ROW_GAP 前先确认前端还是 4。
                h += wh + ROW_GAP;
            }
            return [w, Math.max(h, 80)];
        };

        // ── 工作流存取的控件值：自己接管 ───────────────────────────────
        // 前端的写法有个坑：serialize() 把值写在【widgets 数组下标】上（跳过控件的位置
        // 留成空洞），configure() 却按【第几个可序列化控件】往下读。两种口径只要不一致，
        // 夹在中间的不序列化控件就会把后面的控件整体顶偏。
        // 症状就是用户报的那个：保存再打开，提示词框变空、或串成某一行 LoRA 的 JSON。
        // 这里统一写成紧凑数组，写和读的口径就永远一致了。
        const origSerialize = node.serialize;
        node.serialize = function () {
            const o = origSerialize.apply(this, arguments);
            try {
                o.widgets_values = (this.widgets || [])
                    .filter((wd) => wd && wd.serialize !== false)
                    .map((wd) => wd.value);
            } catch (e) {
                console.error("[小岚lora阵列] 序列化控件值失败:", e);
            }
            return o;
        };

        const origConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            // 兜住旧工作流：早期版本存下来的 widgets_values 是"按 widgets 数组下标写、
            // 中间留空洞"的稀疏格式，而且长度会随行数变化，原生回填会读错位。
            // 这里按"头段固定 + 尾段从右往左认"的规律重新对齐一遍（详见 restoreWidgetValues）。
            //
            // 为什么前后各来一次：原生回填到底发生在 onConfigure 之前还是之内，
            // 是前端内部实现细节（实测这一版是"之前"）。两处都跑一遍，无论哪种实现都对，
            // 而且这个函数是幂等的，重复执行不会出错。
            const vals = info && info.widgets_values;
            try {
                restoreWidgetValues(this, vals);
            } catch (e) {
                console.error("[小岚lora阵列] 旧工作流控件值修复失败:", e);
            }
            const r = origConfigure?.apply(this, arguments);
            try {
                restoreWidgetValues(this, vals);
            } catch (e) {
                /* ignore */
            }
            // 自愈：旧版本的控件错位 bug 会把某一行的状态 JSON 写进提示词框并连同工作流
            // 一起存下来。用户打开就是一堆 {"lora":"None","w":1,...}，完全看不懂。
            // 认出来直接清空（只认那种"整段就是一个行状态对象"的值，不会误伤正常提示词）。
            try {
                const pw = this.__xiaolan && this.__xiaolan.promptW;
                if (pw && isRowStateJson(pw.value)) {
                    console.warn(
                        "[小岚lora阵列] 提示词框里存的是行状态数据（旧版本错位 bug 留下的），已自动清空，请重新填写。"
                    );
                    pw.value = "";
                }
            } catch (e) {
                /* ignore */
            }
            try {
                const incoming = readInitialRows(this);
                setRows(this, incoming.length ? incoming : [{ ...DEFAULT_STATE }]);
                setTexts(this, readInitialTexts(this));
            } catch (e) {
                console.error("[小岚lora阵列] onConfigure 失败:", e);
            }
            return r;
        };

        // 拖动右下角改高度时立刻重绘一帧：
        // 前端在 drawNode 里每帧都会 arrange()，把多出来的高度分给提示词框，
        // DOM 层的 textarea 才会跟着长高。拖动过程中画布本来就在重绘，
        // 这里补一次是为了照顾"程序化改高度"（脚本、对齐工具）的情况。
        // 顺便记住"用户拉出来的那一截"：refresh() 重新 setSize 要靠它把这一截留住。
        const origResize = node.onResize;
        node.onResize = function (size) {
            const r = origResize?.apply(this, arguments);
            try {
                const st2 = this.__xiaolan;
                // !_selfResize：只认外部改的高度。我们自己 setSize 时不算，
                // 否则"自动高度变了"会被误读成"用户拉伸了"，误差逐次累积。
                if (st2 && !st2._selfResize) {
                    const now = this.size?.[1] ?? 0;
                    const base = typeof st2.autoH === "number" ? st2.autoH : now;
                    st2.userExtra = Math.max(0, now - base);
                }
                setDirty();
            } catch (e) {
                /* ignore */
            }
            return r;
        };

        node.__xiaolan_ready = true;
        setRows(node, readInitialRows(node));
        setTexts(node, readInitialTexts(node));
        ok = true;
    } catch (err) {
        console.error("[小岚lora阵列] 初始化失败:", err);
    } finally {
        node.__xiaolan_busy = false;
    }
    return ok;
}

// -----------------------------------------------------------------------------
// 扩展注册
// -----------------------------------------------------------------------------
let registered = false;

function register(app) {
    if (registered || !app?.registerExtension) return false;
    registered = true;

    console.log(`%c[小岚lora阵列] 前端扩展已加载 ${VERSION}`, "color:#60a5fa;font-weight:bold");

    bindHoverTracking();

    app.registerExtension({
        name: "ComfyUI.XiaoLanLoraArray",

        async init() {
            fetchLoraList().catch(() => {});
        },

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (!NODE_NAMES.has(nodeData?.name) && !NODE_NAMES.has(nodeData?.comfyClass)) return;

            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                try {
                    if (this.size && this.size[0] < NODE_W) this.size[0] = NODE_W;
                    upgradeNode(this);
                } catch (err) {
                    console.error("[小岚lora阵列] onNodeCreated 失败:", err);
                }
                return r;
            };

            // 最终兜底：只要节点被画过一帧，就一定升级
            const origDraw = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function (ctx) {
                if (!this.__xiaolan_ready) {
                    try {
                        upgradeNode(this);
                    } catch (e) {
                        /* ignore */
                    }
                }
                return origDraw?.apply(this, arguments);
            };
        },

        loadedGraphNode(node) {
            try {
                if (NODE_NAMES.has(node?.type)) {
                    upgradeNode(node);
                    if (node.__xiaolan_ready) {
                        const rows = readInitialRows(node);
                        setRows(node, rows.length ? rows : [{ ...DEFAULT_STATE }]);
                        setTexts(node, readInitialTexts(node));
                    }
                }
            } catch (e) {
                console.error("[小岚lora阵列] loadedGraphNode 失败:", e);
            }
        },

        async setup() {
            try {
                for (const n of app.graph?._nodes || []) {
                    if (NODE_NAMES.has(n?.type)) upgradeNode(n);
                }
            } catch (e) {
                console.error("[小岚lora阵列] setup 扫描失败:", e);
            }
        },
    });
    return true;
}

// 立即尝试注册；comfyAPI 未就绪就轮询等待（否则整个扩展会静默失效）
(function boot(tries = 0) {
    if (register(getApp())) return;
    if (tries > 600) {
        console.error("[小岚lora阵列] 无法获取 ComfyUI app 实例，扩展未注册");
        return;
    }
    setTimeout(() => boot(tries + 1), 50);
})();
