import json

import folder_paths
import comfy.sd
import comfy.utils

# ComfyUI 的输出端口必须在节点注册时固定，所以"每行一个独立触发词输出"的端口数
# 只能是个固定值；行数本身不受这个限制——超过 MAX_OUTPUTS 的行依旧会加载 LoRA、
# 依旧并入"触发词合并输出"，只是没有自己的单独端口。
MAX_OUTPUTS = 30
MAX_ROWS = 200       # 行数安全上限（界面实际上不会碰到）
MAX_TEXTS = 50       # 文本列表条数上限（前端同值，见 lora_array.js 的 MAX_TEXTS）
LEGACY_SLOTS = 10    # 旧版本固定 10 行，保留用于迁移旧工作流


def _as_bool(value, default=True):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "off", "no", "")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _normalize(d):
    """把任意来源的 dict 归一化成一行。"""
    if not isinstance(d, dict):
        return None
    return {
        "lora": str(d.get("lora") or "None"),
        "w": d.get("w", 1.0),
        "t": str(d.get("t") or ""),
        "e": _as_bool(d.get("e", True)),
    }


def _parse_row(raw):
    """单行值 → 行 dict，解析失败返回 None。

    正常由前端写入 JSON；若拿到纯文本（手改工作流、旧版残留），
    就当作"只选了 LoRA 文件、权重 1.0、无触发词、已启用"。
    """
    if raw is None:
        return None
    if isinstance(raw, dict):
        return _normalize(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        try:
            data = json.loads(s)
        except Exception:
            return {"lora": s, "w": 1.0, "t": "", "e": True}
        return _normalize(data)
    return None


def _parse_rows_data(raw):
    """rows_data：全部行的 JSON 数组（界面自动维护，行数不限）。"""
    if not raw:
        return []
    if isinstance(raw, list):
        data = raw
    elif isinstance(raw, str):
        try:
            data = json.loads(raw)
        except Exception:
            return []
    else:
        return []
    if not isinstance(data, list):
        return []
    rows = []
    for item in data:
        row = _parse_row(item)
        if row is not None:
            rows.append(row)
    return rows


def _parse_legacy(lora_count, legacy):
    """旧工作流（row_1..row_10 + lora_count）迁移。"""
    try:
        n = int(lora_count)
    except (TypeError, ValueError):
        n = 0

    if n > 0:
        rows = []
        for i in range(1, min(n, LEGACY_SLOTS) + 1):
            row = _parse_row(legacy.get(f"row_{i}"))
            rows.append(row or {"lora": "None", "w": 1.0, "t": "", "e": True})
        return rows

    rows = []
    for i in range(1, LEGACY_SLOTS + 1):
        row = _parse_row(legacy.get(f"row_{i}"))
        if row is not None and ((row["lora"] and row["lora"] != "None") or row["t"]):
            rows.append(row)
    return rows


def _merge_text(prompt, triggers):
    """提示词在前、触发词依次在后，用逗号拼成一段可直接喂给 CLIP 的文本。

    各部分会去掉首尾空白和多余的逗号，空片段直接跳过，
    所以"没写提示词"或"没填触发词"都不会留下孤零零的逗号。
    提示词不受总开关影响——总开关只负责 LoRA 与触发词。
    """
    parts = []
    for chunk in [prompt, *triggers]:
        s = (chunk or "").strip().strip(",").strip()
        if s:
            parts.append(s)
    return ", ".join(parts)


def _parse_texts_data(raw):
    """解析「文本列表」（JSON 数组）→ 本次要拼进输出的文本片段列表。

    每条形如 {"title": "备注", "text": "正文", "e": true}：
      · title 只是界面上的备注/标题，**永远不参与输出**；
      · text 才是正文，会按顺序拼进合并文本；
      · e=False 表示这条在界面上被关掉，跳过。

    容错：拿到纯字符串（手改工作流）就当作正文本身；
    拿到坏 JSON 就返回空列表，绝不让节点因为一段备注而报错。
    """
    if not raw:
        return []
    try:
        arr = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    if isinstance(arr, dict):
        arr = [arr]
    if not isinstance(arr, list):
        return []

    out = []
    for item in arr[:MAX_TEXTS]:
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
            continue
        if not isinstance(item, dict):
            continue
        if not _as_bool(item.get("e", True)):
            continue
        s = str(item.get("text") or "").strip()
        if s:
            out.append(s)
    return out


def _apply_rows(model, toggle, lora_count, rows_data, legacy):
    """解析行 → 逐行套用 LoRA → 返回 (新 model, 生效触发词列表, 每行触发词)。

    两个节点共用这段逻辑，保证行为完全一致。
    """
    rows = _parse_rows_data(rows_data)
    if not rows:
        rows = _parse_legacy(lora_count, legacy)
    if len(rows) > MAX_ROWS:
        rows = rows[:MAX_ROWS]

    merged = []
    per_row = [""] * MAX_OUTPUTS
    out_model = model

    for idx, row in enumerate(rows):
        # 单行开关：关掉的行既不加 LoRA，也不输出触发词
        if not row.get("e", True):
            continue
        # 总开关关闭 = 整节点旁路：模型透传，触发词也一并清空
        if not toggle:
            continue

        trigger = (row.get("t") or "").strip()
        name = row.get("lora") or "None"

        if name and name != "None":
            try:
                strength = float(row.get("w", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            if strength != 0.0:
                lora_path = folder_paths.get_full_path("loras", name)
                if lora_path is None:
                    raise RuntimeError(f"[小岚lora阵列] 找不到 LoRA 文件: {name}")
                try:
                    lora_data = comfy.utils.load_torch_file(lora_path, safe_load=True)
                    (out_model,) = comfy.sd.load_lora_for_models(
                        out_model, None, lora_data, strength, 0.0
                    )[:1]
                except Exception as e:
                    raise RuntimeError(f"[小岚lora阵列] 加载 LoRA 失败: {name}\n{e}")

        if idx < MAX_OUTPUTS:
            per_row[idx] = trigger
        if trigger:
            merged.append(trigger)

    return out_model, merged, per_row


class XiaoLanLoraArray:
    """小岚 LoRA 阵列：行数不限，每行从左往右（开关 | LoRA | 权重 | 触发词 | 删除），
    每行可单独启用/停用，每行独立触发词输出 + 顶部触发词合并输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "toggle": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "ON",
                        "label_off": "OFF",
                        "tooltip": "总开关：一键开启/关闭全部 LoRA",
                    },
                ),
                # 以下三项均由前端界面自动维护，界面上不可见。
                # lora_count / row_1..row_10 仅为兼容旧工作流保留，rows_data 才是真正数据源。
                "lora_count": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_ROWS,
                        "tooltip": "旧版行数（保留兼容，界面不使用）",
                    },
                ),
                **{
                    f"row_{i}": (
                        "STRING",
                        {"default": "", "multiline": False, "tooltip": "旧版行数据（保留兼容）"},
                    )
                    for i in range(1, LEGACY_SLOTS + 1)
                },
                "rows_data": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "全部 LoRA 行（JSON 数组），由界面自动维护，行数不限",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING") + ("STRING",) * MAX_OUTPUTS
    RETURN_NAMES = ("model", "触发词合并输出") + tuple(
        f"触发词{i}" for i in range(1, MAX_OUTPUTS + 1)
    )
    FUNCTION = "load"
    CATEGORY = "loaders"

    DESCRIPTION = (
        "小岚 LoRA 阵列：行数不限。点击「＋ 添加 LoRA」增加行，点击行内 LoRA 名称弹出下拉选择，"
        "权重在 LoRA 左侧（＋/－ 或按住拖动），中间是每行的单独启用开关，右侧触发词，行尾 ✕ 删除该行。"
        "「触发词合并输出」汇总所有已启用行的触发词；每行另有独立输出（触发词1…触发词30，"
        f"超过 {MAX_OUTPUTS} 行的部分只并入合并输出）。只作用于 MODEL，不加载 CLIP。"
    )

    def load(self, model, toggle, lora_count=0, rows_data="", **legacy):
        out_model, merged, per_row = _apply_rows(model, toggle, lora_count, rows_data, legacy)
        return tuple([out_model, ", ".join(merged)] + per_row)


class XiaoLanLoraArrayPrompt(XiaoLanLoraArray):
    """小岚 LoRA 阵列（提示词版）：和「小岚lora阵列」完全一样，只是多一个多行提示词框，
    并把「文本触发词合并输出」合并成 提示词 + 各生效行的触发词。"""

    @classmethod
    def INPUT_TYPES(cls):
        base = XiaoLanLoraArray.INPUT_TYPES()
        # 文本列表：界面自动维护的 JSON 数组，元素 {title, text, e}。
        # title 只作备注、不参与输出；text 按顺序拼进合并文本。
        # 和 rows_data 一样藏在界面上不显示，条数不受 INPUT_TYPES 固定槽位限制。
        base["required"]["texts_data"] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "tooltip": "文本列表（JSON 数组），由界面自动维护；标题只作备注，不参与输出",
            },
        )
        # 放在最后，界面里排在「＋ 添加 LoRA」按钮下方
        base["required"]["prompt_text"] = (
            "STRING",
            {
                "default": "",
                "multiline": True,
                "tooltip": "在这里写提示词；会和各行触发词合并后从「文本触发词合并输出」输出",
            },
        )
        # forceInput：只出一个输入端口，界面上不生成控件
        base["optional"] = {
            "text_in": (
                "STRING",
                {
                    "forceInput": True,
                    "tooltip": "外部接进来的文字，会拼在提示词最前面（适合放公共前缀 / 风格词）",
                },
            )
        }
        return base

    # 注意："文本输出" 追加在最后。输出端口是按序号连线的，追加不会挪动
    # 已有端口的位置，旧工作流不会错位。
    RETURN_TYPES = ("MODEL", "STRING") + ("STRING",) * MAX_OUTPUTS + ("STRING",)
    RETURN_NAMES = ("model", "文本触发词合并输出") + tuple(
        f"触发词{i}" for i in range(1, MAX_OUTPUTS + 1)
    ) + ("文本输出",)
    FUNCTION = "load"
    CATEGORY = "loaders"

    DESCRIPTION = (
        "小岚 LoRA 阵列（提示词版）：在「小岚lora阵列」的基础上多一个多行提示词框、"
        "一个可增删的「文本列表」，以及提示词专用的「文本输入 / 文本输出」端口。\n"
        "文本触发词合并输出 = 文本输入 + 提示词框内容 + 文本列表各条正文 + 各已启用行的触发词（逗号连接）。"
        "「文本输出」内容与它完全相同，只是多一个紧挨提示词框的出口，方便就近接线。\n"
        "文本列表每条的「标题」只是给你自己看的备注，不参与输出；每条左侧的开关可以临时停用它。\n"
        "提示词框右侧有一个只读的「最终文本预览」；两个框中间的分隔条可以左右拖动调整宽度比"
        "（双击恢复默认），比例会随工作流一起保存。\n"
        "总开关只影响 LoRA 与触发词，你写的提示词和文本列表始终保留。"
        "其余操作与「小岚lora阵列」完全一致：点「＋ 添加 LoRA」增加行，点行内 LoRA 名称弹出下拉选择，"
        "每行从左往右依次是 开关 / LoRA / 权重 / 触发词 / 删除，行数不限。"
    )

    def load(self, model, toggle, lora_count=0, rows_data="", texts_data="", prompt_text="", text_in="", **legacy):
        out_model, merged, per_row = _apply_rows(model, toggle, lora_count, rows_data, legacy)
        # 顺序：外部输入 → 提示词框 → 文本列表 → 各行触发词
        text = _merge_text(text_in, [prompt_text, *_parse_texts_data(texts_data), *merged])
        return tuple([out_model, text] + per_row + [text])


NODE_CLASS_MAPPINGS = {
    "XiaoLanLoraArray": XiaoLanLoraArray,
    "XiaoLanLoraArrayPrompt": XiaoLanLoraArrayPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaoLanLoraArray": "小岚lora阵列",
    "XiaoLanLoraArrayPrompt": "小岚lora阵列 + 提示词",
}
