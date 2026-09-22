"""Bounded, scope-aware semantic memory retrieval."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from deepresearch_agent.persistence.repositories import MemoryRepository
from deepresearch_agent.persistence.repositories.utils import utc_now_iso


def lexical_terms(value: str) -> set[str]:
    lowered = value.lower()
    words = set(re.findall(r"[a-z0-9_]{2,}", lowered))
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", lowered))
    words.update(cjk[index:index + 2] for index in range(max(0, len(cjk) - 1)))
    return {item for item in words if item}


@dataclass(frozen=True)
class RetrievedMemory:
    memory_id: str
    content: str
    scope: str
    kind: str
    confidence: float
    provenance_refs: list[str]
    score: float


class MemoryRetriever:
    def __init__(self, repository: MemoryRepository, *, max_chars: int = 6000):
        self.repository = repository
        self.max_chars = max(200, max_chars)

    async def retrieve(self, query: str, *, session_id: str, max_chars: int | None = None) -> list[RetrievedMemory]:
        candidates = await self.repository.list_available(session_id=session_id, now=utc_now_iso())
        query_terms = lexical_terms(query)
        ranked: list[RetrievedMemory] = []
        for item in candidates:
            content_terms = lexical_terms(item.content)
            overlap = len(query_terms & content_terms)
            if query_terms and overlap == 0:
                continue
            relevance = overlap / max(1, len(query_terms))
            scope_bonus = {"session": 0.2, "project": 0.15, "user": 0.1, "domain": 0.05}.get(item.scope, 0.0)
            ranked.append(RetrievedMemory(
                memory_id=item.memory_id, content=item.content, scope=item.scope, kind=item.kind,
                confidence=item.confidence, provenance_refs=json.loads(item.provenance_json or "[]"),
                score=relevance + scope_bonus + item.confidence * 0.1,
            ))
        ranked.sort(key=lambda value: (-value.score, value.memory_id))
        budget, used, selected = max_chars or self.max_chars, 0, []
        for item in ranked:
            size = len(item.content)
            if selected and used + size > budget:
                continue
            if size > budget:
                item = RetrievedMemory(**{**item.__dict__, "content": item.content[:budget]})
                size = len(item.content)
            selected.append(item)
            used += size
            if used >= budget:
                break
        return selected

