"""Run-scoped Evidence Ledger bridge from provider results to persistence."""

from __future__ import annotations

import hashlib
import re
from typing import Iterable, Optional

from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult
from deepresearch_agent.harness.contracts import EvidenceData, SourceMode
from deepresearch_agent.persistence.repositories.trajectory import EvidenceRepository


class EvidenceLedger:
    def __init__(self, repository: Optional[EvidenceRepository] = None):
        self._repository = repository

    def assign(
        self,
        *,
        run_id: str,
        task_id: Optional[str],
        tool_call_id: Optional[str],
        provider: str,
        results: Iterable[RetrievalResult],
    ) -> list[tuple[RetrievalResult, EvidenceData]]:
        assigned: list[tuple[RetrievalResult, EvidenceData]] = []
        for result in results:
            mode = SourceMode(result.source_mode)
            source_id = result.metadata.source_id
            digest = result.metadata.content_hash or hashlib.sha256(str(result.evidence).encode("utf-8")).hexdigest()
            evidence_id = "ev_" + hashlib.sha256(
                f"{run_id}:{mode.value}:{source_id}:{digest}".encode("utf-8")
            ).hexdigest()[:24]
            result.result_id = evidence_id
            result.metadata.content_hash = digest
            result.metadata.extra.update({
                "run_id": run_id,
                "task_id": task_id,
                "tool_call_id": tool_call_id,
                "provider": provider,
            })
            artifact_id = result.metadata.extra.get("artifact_id")
            data = EvidenceData(
                evidence_id=evidence_id,
                run_id=run_id,
                task_id=task_id,
                tool_call_id=tool_call_id,
                source_mode=mode,
                provider=provider,
                source_id=source_id,
                title=result.metadata.title,
                summary=self._summary(result.evidence),
                content_hash=digest,
                artifact_id=str(artifact_id) if artifact_id else None,
                score=result.score,
            )
            assigned.append((result, data))
        return assigned

    async def record_results(
        self,
        *,
        run_id: str,
        task_id: Optional[str],
        tool_call_id: Optional[str],
        provider: str,
        results: Iterable[RetrievalResult],
    ) -> list[EvidenceData]:
        assigned = self.assign(
            run_id=run_id, task_id=task_id, tool_call_id=tool_call_id,
            provider=provider, results=results,
        )
        saved = [data for _, data in assigned]
        if self._repository is None:
            return saved
        for result, data in assigned:
            await self._repository.upsert(data, metadata=result.metadata.model_dump(mode="json"))
        return saved

    @staticmethod
    def _summary(value: object, *, limit: int = 1200) -> str:
        """Produce a compact, readable evidence preview; raw content stays in artifacts."""
        text = str(value or "")
        text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
        text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
        text = re.sub(r"(?m)^\s*(登录|注册|导航|首页|菜单|Cookie|隐私|广告).*$", "", text, flags=re.I)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:limit] + ("…" if len(text) > limit else "")


__all__ = ["EvidenceLedger"]
