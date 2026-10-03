"""用于从 LLM 输出中提取 JSON 片段的工具函数。"""
import json
import re
from typing import Any, Dict

_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_json_text(text: str) -> str:
    """从带格式的模型输出中提取 JSON 子串。"""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("空响应，无法提取JSON")

    fenced = _CODE_BLOCK_RE.search(cleaned)
    if fenced:
        candidate = fenced.group(1).strip()
        if candidate:
            return candidate

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("未找到JSON结构")
    return cleaned[start : end + 1]


def parse_json_text(text: str) -> Dict[str, Any]:
    """将模型输出解析为 JSON 对象，解析失败时抛出 ValueError。"""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("空响应，无法解析JSON")

    candidates = [match.group(1).strip() for match in _CODE_BLOCK_RE.finditer(cleaned)]
    candidates.append(cleaned)
    decoder = json.JSONDecoder()

    # 模型可能在主 JSON 前后输出思考文本、示例或第二个对象。逐个扫描
    # 完整对象，避免使用首个“{”到末个“}”的贪婪切片把它们拼在一起。
    for candidate in candidates:
        for match in re.finditer(r"{", candidate):
            try:
                parsed, _ = decoder.raw_decode(candidate[match.start() :])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

    try:
        parsed = json.loads(extract_json_text(cleaned))
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("无法解析JSON结构") from exc
    if not isinstance(parsed, dict):
        raise ValueError("JSON顶层结构必须是对象")
    return parsed


__all__ = ["extract_json_text", "parse_json_text"]
