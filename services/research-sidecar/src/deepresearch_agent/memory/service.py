"""Semantic memory lifecycle with provenance, conflict, and audit controls."""

from __future__ import annotations

import json
from typing import Any

from deepresearch_agent.persistence.repositories import AuditRepository, MemoryRepository

from .policies import MemoryPolicy
from .retriever import lexical_terms


class MemoryRejected(ValueError):
    pass


class MemoryService:
    VALID_STATUSES = {"candidate", "active", "rejected", "expired"}

    def __init__(self, repository: MemoryRepository, audit: AuditRepository, *, policy: MemoryPolicy | None = None):
        self.repository, self.audit = repository, audit
        self.policy = policy or MemoryPolicy()

    async def create_candidate(
        self, *, content: str, scope: str, kind: str, provenance_refs: list[str], confidence: float,
        session_id: str | None = None, created_by: str = "agent", expires_at: str | None = None,
    ):
        verdict = self.policy.validate(content)
        if not verdict.allowed:
            await self.audit.append(action="memory.rejected_by_policy", entity_type="memory", entity_id="pending", payload={"reason": verdict.reason})
            raise MemoryRejected(verdict.reason or "Memory policy rejected")
        if kind == "fact" and not provenance_refs:
            raise MemoryRejected("事实类 Memory 必须包含 provenance")
        supersedes = None
        candidate_terms = lexical_terms(content)
        for active in await self.repository.list_active_for_conflict(scope=scope, kind=kind, session_id=session_id):
            active_terms = lexical_terms(active.content)
            similarity = len(candidate_terms & active_terms) / max(1, min(len(candidate_terms), len(active_terms)))
            if similarity >= 0.45 and active.content.strip() != content.strip():
                supersedes = active.memory_id
                break
            if active.content.strip() == content.strip():
                return active
        item = await self.repository.create_candidate(
            content=content.strip(), scope=scope, kind=kind, provenance_refs=provenance_refs,
            confidence=max(0.0, min(1.0, confidence)), session_id=session_id,
            created_by=created_by, supersedes=supersedes, expires_at=expires_at,
        )
        await self.audit.append(action="memory.candidate_created", entity_type="memory", entity_id=item.memory_id, payload={"supersedes": supersedes, "provenance_refs": provenance_refs})
        return item

    async def update(self, memory_id: str, *, content: str | None = None, status: str | None = None, expires_at: str | None = None):
        item = await self.repository.get(memory_id)
        if item is None:
            return None
        values: dict[str, Any] = {}
        if content is not None:
            verdict = self.policy.validate(content)
            if not verdict.allowed:
                raise MemoryRejected(verdict.reason or "Memory policy rejected")
            values["content"] = content.strip()
        if status is not None:
            if status not in self.VALID_STATUSES:
                raise ValueError("非法 Memory 状态")
            values["status"] = status
        if expires_at is not None:
            values["expires_at"] = expires_at
        if values:
            await self.repository.update_lifecycle(memory_id, **values)
            await self.audit.append(action="memory.updated", entity_type="memory", entity_id=memory_id, payload=values)
        return await self.repository.get(memory_id)

    async def delete(self, memory_id: str) -> bool:
        deleted = await self.repository.soft_delete(memory_id)
        if deleted:
            await self.audit.append(action="memory.deleted", entity_type="memory", entity_id=memory_id)
        return deleted

    @staticmethod
    def serialize(item) -> dict[str, Any]:
        return {
            "memory_id": item.memory_id, "session_id": item.session_id, "scope": item.scope,
            "kind": item.kind, "content": item.content,
            "provenance_refs": json.loads(item.provenance_json or "[]"), "confidence": item.confidence,
            "valid_from": item.valid_from, "expires_at": item.expires_at, "supersedes": item.supersedes,
            "status": item.status, "created_by": item.created_by,
            "created_at": item.created_at, "updated_at": item.updated_at,
        }


# Compatibility: the production implementation is the bounded curated store.
# Keep this module path importable while preventing a second Memory behavior.
from .curated import CuratedMemoryService, MemoryRejected, MemoryService  # noqa: E402,F401

