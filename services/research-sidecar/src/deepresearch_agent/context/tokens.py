"""Small tokenizer facade used by context and curated-memory budgets."""

from __future__ import annotations

import re


def count_tokens(value: str) -> int:
    """Return a deterministic conservative token estimate."""
    if not value:
        return 0
    try:
        import tiktoken

        return len(tiktoken.get_encoding("cl100k_base").encode(value))
    except Exception:
        cjk = len(re.findall(r"[\u3400-\u9fff]", value))
        remainder = re.sub(r"[\u3400-\u9fff]", "", value)
        latin = len(re.findall(r"[A-Za-z0-9_]+|[^\sA-Za-z0-9_]", remainder))
        return max(1, cjk + latin)
