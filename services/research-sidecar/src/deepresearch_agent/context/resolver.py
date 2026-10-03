"""Resolve referential follow-ups using only bounded current-Session context."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ResolvedQuery:
    original_query: str
    resolved_query: str
    used_message_ids: list[str]
    assumptions: list[str]
    confidence: float = 1.0


class QueryResolver:
    _reference = re.compile(r"(?:它|他|她|他们|这个|那个|上述|前面|该|那|呢|继续|再说|相比之下|这一部分|这部分)")

    def resolve(self, query: str, history) -> ResolvedQuery:
        previous = [item for item in history if getattr(item, "role", "") in {"user", "assistant"}]
        referential = bool(self._reference.search(query)) or (len(query.strip()) <= 24 and bool(previous))
        if referential and not previous:
            return ResolvedQuery(
                query, query, [], ["当前 Session 中没有足够信息消解指代"], 0.4,
            )
        if not referential:
            return ResolvedQuery(query, query, [], [], 1.0)
        selected = previous[-4:]
        context = "；".join(f"{item.role}: {item.content[:300]}" for item in selected)
        resolved = f"基于同一会话的已知上下文（仅用于消解指代）：{context}\n当前追问：{query}"
        return ResolvedQuery(query, resolved, [item.message_id for item in selected], [], 0.9)
