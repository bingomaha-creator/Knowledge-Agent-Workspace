"""Derive evaluation metrics from the durable run fact store."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from statistics import mean
from typing import Iterable

from sqlalchemy import select

from deepresearch_agent.persistence.database import Database
from deepresearch_agent.persistence.models import (
    CheckpointModel,
    ContractCheckModel,
    EvidenceModel,
    MessageModel,
    RunEventModel,
    RunModel,
    TaskModel,
    ToolCallModel,
)

from .metrics import retrieval_metrics
from .models import EvaluationLabels, EvaluationSummary, RunEvaluation

_CITATION = re.compile(r"\[\^?(ev_[A-Za-z0-9_-]+)\]")


def _json(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


class EvaluationService:
    """Compute reproducible metrics without mutating evaluated runs."""

    def __init__(self, database: Database):
        self.database = database

    async def evaluate_run(
        self, run_id: str, *, labels: EvaluationLabels | None = None, retrieval_k: int = 10
    ) -> RunEvaluation:
        labels = labels or EvaluationLabels()
        async with self.database.sessions() as session:
            run = await session.get(RunModel, run_id)
            if run is None:
                raise ValueError(f"Run 不存在: {run_id}")
            events = list((await session.execute(select(RunEventModel).where(RunEventModel.run_id == run_id).order_by(RunEventModel.event_id))).scalars())
            checks = list((await session.execute(select(ContractCheckModel).where(ContractCheckModel.run_id == run_id))).scalars())
            evidence = list((await session.execute(select(EvidenceModel).where(EvidenceModel.run_id == run_id, EvidenceModel.invalidated_at.is_(None)).order_by(EvidenceModel.score.desc(), EvidenceModel.created_at))).scalars())
            calls = list((await session.execute(select(ToolCallModel).where(ToolCallModel.run_id == run_id))).scalars())
            checkpoints = list((await session.execute(select(CheckpointModel).where(CheckpointModel.run_id == run_id))).scalars())
            tasks = list((await session.execute(select(TaskModel).where(TaskModel.run_id == run_id))).scalars())
            report = (await session.execute(select(MessageModel).where(MessageModel.run_id == run_id, MessageModel.role == "assistant"))).scalars().first()

        event_types = [item.event_type for item in events]
        required = [item for item in checks if item.required == 1]
        contract_results = {item.kind: None if item.passed is None else bool(item.passed) for item in checks}
        required_passes = sum(item.passed == 1 for item in required)
        verified = run.status == "completed" and bool(required) and required_passes == len(required)

        report_text = report.content if report else ""
        citations = _CITATION.findall(report_text)
        evidence_ids = {item.evidence_id for item in evidence}
        valid_citations = [item for item in citations if item in evidence_ids]

        unique_hashes = {item.content_hash for item in evidence if item.content_hash}
        source_ids: set[str] = set()
        for item in evidence:
            metadata = _json(item.metadata_json)
            source_key = metadata.get("domain") if run.source_mode == "web" else None
            source_key = str(source_key or item.source_id or "")
            if source_key:
                source_ids.add(source_key)
        duplicate_fingerprints: dict[str, int] = {}
        for call in calls:
            raw = f"{call.task_id}|{call.tool_name}|{call.source_mode}|{call.args_json}"
            fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()
            duplicate_fingerprints[fingerprint] = duplicate_fingerprints.get(fingerprint, 0) + 1
        duplicates = sum(count - 1 for count in duplicate_fingerprints.values() if count > 1)

        checkpoint_valid = sum(
            hashlib.sha256(item.state_json.encode("utf-8")).hexdigest() == item.state_hash
            for item in checkpoints
        )
        # Count retry attempts, not the transition back to execution.
        retry_count = sum(item == "run.retrying" for item in event_types)
        replan_count = sum(item == "plan.replanning" for item in event_types)
        recovery_attempted = any(item in {"run.resumed", "run.recovered"} for item in event_types)

        usage_container = _json(run.usage_json)
        usage = usage_container.get("usage", usage_container)
        llm_tokens = int(usage.get("llm_tokens", 0) or 0)
        cache_hit = int(usage.get("prefix_cache_hit_tokens", 0) or 0)
        cache_miss = int(usage.get("prefix_cache_miss_tokens", 0) or 0)
        started, completed = _timestamp(run.started_at), _timestamp(run.completed_at)
        latency_ms = (completed - started).total_seconds() * 1000 if started and completed else None

        retrieval = None
        if labels.relevant_source_ids:
            retrieval = retrieval_metrics(
                [item.source_id for item in evidence], labels.relevant_source_ids, k=retrieval_k
            ).model_dump()

        honest_failure = None
        if labels.expected_honest_failure is not None:
            is_honest = run.status in {"failed", "needs_user_input", "budget_exhausted"} or bool(
                re.search(r"证据不足|无法确认|局限|限制", report_text, re.I)
            )
            honest_failure = is_honest if labels.expected_honest_failure else None

        claim_check = next((item for item in checks if item.kind == "claim_support"), None)
        return RunEvaluation(
            run_id=run.run_id,
            status=run.status,
            source_mode=run.source_mode,
            workflow_mode=run.workflow_mode,
            verified_completion=verified,
            first_pass_completion=verified and retry_count == 0 and replan_count == 0 and not recovery_attempted,
            required_contract_pass_rate=required_passes / len(required) if required else 0.0,
            required_contract_total=len(required),
            contract_results=contract_results,
            citation_count=len(citations),
            valid_citation_count=len(valid_citations),
            citation_validity=len(valid_citations) / len(citations) if citations else None,
            claim_support_proxy=None if claim_check is None or claim_check.passed is None else float(claim_check.passed),
            semantic_claim_support_rate=labels.semantic_claim_support_rate,
            report_quality_score=labels.report_quality_score,
            honest_failure=honest_failure,
            evidence_count=len(evidence),
            independent_source_count=len(source_ids),
            evidence_redundancy_rate=1 - len(unique_hashes) / len(evidence) if evidence else 0.0,
            source_leakage_detected=(
                contract_results.get("source_match") is False
                or any(item.source_mode != run.source_mode for item in evidence)
            ),
            retrieval=retrieval,
            retry_count=retry_count,
            replan_count=replan_count,
            recovery_attempted=recovery_attempted,
            recovery_succeeded=verified if recovery_attempted else None,
            checkpoint_count=len(checkpoints),
            checkpoint_integrity_rate=checkpoint_valid / len(checkpoints) if checkpoints else None,
            tool_call_count=len(calls),
            failed_tool_call_count=sum(item.status == "failed" for item in calls),
            duplicate_tool_call_fingerprints=duplicates,
            duplicate_side_effect_rate=duplicates / len(calls) if calls else 0.0,
            task_count=len(tasks),
            latency_ms=latency_ms,
            llm_tokens=llm_tokens,
            tool_calls_reported=int(usage.get("tool_calls", len(calls)) or 0),
            prefix_cache_hit_rate=cache_hit / (cache_hit + cache_miss) if cache_hit + cache_miss else None,
        )

    async def summarize(
        self,
        *,
        run_ids: Iterable[str] | None = None,
        labels_by_run: dict[str, EvaluationLabels] | None = None,
        retrieval_k: int = 10,
        include_runs: bool = True,
    ) -> EvaluationSummary:
        labels_by_run = labels_by_run or {}
        ids = list(run_ids or [])
        if not ids:
            async with self.database.sessions() as session:
                ids = list((await session.execute(select(RunModel.run_id).order_by(RunModel.created_at))).scalars())
        runs = [
            await self.evaluate_run(run_id, labels=labels_by_run.get(run_id), retrieval_k=retrieval_k)
            for run_id in ids
        ]
        count = len(runs)
        verified_count = sum(item.verified_completion for item in runs)
        citations = sum(item.citation_count for item in runs)
        valid_citations = sum(item.valid_citation_count for item in runs)
        evidence_count = sum(item.evidence_count for item in runs)
        duplicate_count = sum(item.duplicate_tool_call_fingerprints for item in runs)
        tool_count = sum(item.tool_call_count for item in runs)
        recovery_runs = [item for item in runs if item.recovery_attempted]
        replan_runs = [item for item in runs if item.replan_count > 0]
        honest = [item.honest_failure for item in runs if item.honest_failure is not None]
        semantic = [item.semantic_claim_support_rate for item in runs if item.semantic_claim_support_rate is not None]
        quality = [item.report_quality_score for item in runs if item.report_quality_score is not None]
        checkpoint_count = sum(item.checkpoint_count for item in runs)
        valid_checkpoint_count = sum(
            (item.checkpoint_integrity_rate or 0.0) * item.checkpoint_count for item in runs
        )
        latencies = [item.latency_ms for item in runs if item.latency_ms is not None]
        retrieval_runs = [item.retrieval for item in runs if item.retrieval is not None]

        def retrieval_mean(key: str) -> float | None:
            return mean(item[key] for item in retrieval_runs) if retrieval_runs else None

        return EvaluationSummary(
            run_count=count,
            verified_completion_rate=verified_count / count if count else 0.0,
            first_pass_completion_rate=sum(item.first_pass_completion for item in runs) / count if count else 0.0,
            mean_required_contract_pass_rate=mean(item.required_contract_pass_rate for item in runs) if runs else 0.0,
            citation_validity=valid_citations / citations if citations else None,
            semantic_claim_support_rate=mean(semantic) if semantic else None,
            mean_report_quality_score=mean(quality) if quality else None,
            honest_failure_rate=sum(bool(item) for item in honest) / len(honest) if honest else None,
            source_leakage_rate=sum(item.source_leakage_detected for item in runs) / count if count else 0.0,
            evidence_redundancy_rate=sum(item.evidence_redundancy_rate * item.evidence_count for item in runs) / evidence_count if evidence_count else 0.0,
            recovery_attempt_count=len(recovery_runs),
            recovery_success_rate=sum(bool(item.recovery_succeeded) for item in recovery_runs) / len(recovery_runs) if recovery_runs else None,
            replan_attempt_count=len(replan_runs),
            replan_recovery_rate=sum(item.verified_completion for item in replan_runs) / len(replan_runs) if replan_runs else None,
            checkpoint_integrity_rate=valid_checkpoint_count / checkpoint_count if checkpoint_count else None,
            duplicate_side_effect_rate=duplicate_count / tool_count if tool_count else 0.0,
            latency_p50_ms=_percentile(latencies, 0.50),
            latency_p95_ms=_percentile(latencies, 0.95),
            tokens_per_verified_run=sum(item.llm_tokens for item in runs) / verified_count if verified_count else None,
            mean_tool_calls_per_run=tool_count / count if count else 0.0,
            retrieval_precision_at_k=retrieval_mean("precision_at_k"),
            retrieval_recall_at_k=retrieval_mean("recall_at_k"),
            retrieval_mrr=retrieval_mean("reciprocal_rank"),
            retrieval_ndcg_at_k=retrieval_mean("ndcg_at_k"),
            runs=runs if include_runs else [],
        )
