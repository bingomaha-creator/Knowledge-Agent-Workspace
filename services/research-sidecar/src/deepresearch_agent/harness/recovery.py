"""Typed retry/replan decisions and startup recovery scanning."""

from __future__ import annotations

from dataclasses import dataclass

from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.persistence.repositories import RunRepository


@dataclass(frozen=True)
class RecoveryDecision:
    action: str
    reason: str


def classify_verification_failures(failures: list[str]) -> RecoveryDecision:
    kinds = set(failures)
    # Evidence/source failures cannot be repaired by rewriting prose. They must
    # return to planning and retrieval before a new report is generated.
    if kinds & {"min_evidence", "claim_support", "source_match"}:
        return RecoveryDecision("replan", ",".join(sorted(kinds)))
    if kinds and kinds.issubset({"citation_integrity", "required_section", "report_consistency", "source_diversity", "evidence_card_coverage"}):
        return RecoveryDecision("repair_report", ",".join(sorted(kinds)))
    return RecoveryDecision("fail", ",".join(sorted(kinds)) or "unknown")


def classify_exception(exc: Exception) -> RecoveryDecision:
    """Keep transport retry, auth failure, and plan/contract recovery distinct."""
    if isinstance(exc, AppError):
        if exc.code in {ErrorCode.TAVILY_AUTH_FAILED, ErrorCode.TAVILY_API_KEY_MISSING, ErrorCode.SOURCE_POLICY_VIOLATION}:
            return RecoveryDecision("fail", exc.code.value)
        if exc.retryable or exc.code in {ErrorCode.TAVILY_RATE_LIMITED, ErrorCode.RETRIEVAL_TIMEOUT}:
            return RecoveryDecision("retry_same", exc.code.value)
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return RecoveryDecision("retry_same", type(exc).__name__)
    return RecoveryDecision("fail", type(exc).__name__)


class RecoveryManager:
    def __init__(self, run_repository: RunRepository):
        self.run_repository = run_repository

    async def scan(self, *, auto_resume: bool = True) -> list[str]:
        interrupted = await self.run_repository.mark_expired_leases_interrupted()
        if not auto_resume:
            return interrupted
        recoverable = await self.run_repository.list_recoverable()
        return [run.run_id for run in recoverable if run.status == "interrupted"]
