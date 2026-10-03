"""Frozen stage-0 domain contracts used by persistence and later runtime stages."""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from .versioning import CONTRACT_SCHEMA_VERSION, EVENT_SCHEMA_VERSION


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class SourceMode(str, Enum):
    GRAPHRAG = "graphrag"
    WEB = "web"


class WorkflowMode(str, Enum):
    DEEP_RESEARCH = "deep_research"
    PLAN_EXECUTE_REPORT = "plan_execute_report"


class RunStatus(str, Enum):
    QUEUED = "queued"
    CONTEXT_BUILDING = "context_building"
    PLANNING = "planning"
    EXECUTING = "executing"
    REPORTING = "reporting"
    VERIFYING = "verifying"
    RETRYING = "retrying"
    REPLANNING = "replanning"
    PAUSED = "paused"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"
    BUDGET_EXHAUSTED = "budget_exhausted"
    NEEDS_USER_INPUT = "needs_user_input"
    INTERRUPTED = "interrupted"


class RunEventData(BaseModel):
    run_id: str
    event_type: str
    stage: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)
    schema_version: int = EVENT_SCHEMA_VERSION


class EvidenceData(BaseModel):
    evidence_id: str
    run_id: str
    task_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    source_mode: SourceMode
    provider: str
    source_id: str
    title: Optional[str] = None
    summary: str
    content_hash: str
    artifact_id: Optional[str] = None
    score: float = Field(default=0.5, ge=0.0, le=1.0)


class ContractCheckData(BaseModel):
    check_id: str
    run_id: str
    kind: Literal["min_evidence", "source_match", "citation_integrity", "claim_support", "report_consistency", "required_section", "source_diversity", "evidence_card_coverage", "custom"]
    required: bool = True
    threshold: Optional[float] = None
    verifier: str
    verifier_version: str
    passed: Optional[bool] = None
    observed: Any = None
    explanation: Optional[str] = None
    artifact_refs: List[str] = Field(default_factory=list)
    schema_version: int = CONTRACT_SCHEMA_VERSION


class ContractVerdict(BaseModel):
    passed: bool
    recoverable: bool = False
    checks: List[ContractCheckData] = Field(default_factory=list)
    failures: List[str] = Field(default_factory=list)


class ContractEvaluator:
    """Run deterministic checks first and persist their VerificationEvidence."""

    def __init__(self, repository=None):
        self.repository = repository

    async def evaluate(
        self,
        *,
        run_id: str,
        source_mode: SourceMode | str,
        report: str,
        evidence: List[Any],
        min_evidence: int = 1,
        required_sections: Optional[List[str]] = None,
        consistency_passed: Optional[bool] = None,
        evidence_card_coverage: Optional[Dict[str, Any]] = None,
    ) -> ContractVerdict:
        from .verifiers import DeterministicVerifiers

        verifier = DeterministicVerifiers(
            run_id=run_id,
            source_mode=SourceMode(source_mode),
            report=report,
            evidence=evidence,
        )
        checks = [
            verifier.source_match(),
            verifier.min_evidence(min_evidence),
            verifier.citation_integrity(),
            verifier.required_section(required_sections or []),
            verifier.claim_support(),
            verifier.report_consistency(consistency_passed),
            verifier.source_diversity(),
        ]
        if evidence_card_coverage is not None:
            # The immutable ledger is authoritative; never accept reporter-provided
            # ledger IDs as proof of its own completeness.
            coverage = dict(evidence_card_coverage)
            coverage["ledger_ids"] = [
                str(item.get("evidence_id", "") if isinstance(item, dict) else getattr(item, "evidence_id", ""))
                for item in evidence
                if str(item.get("evidence_id", "") if isinstance(item, dict) else getattr(item, "evidence_id", ""))
            ]
            checks.append(verifier.evidence_card_coverage(coverage))
        if self.repository is not None:
            for check in checks:
                await self.repository.upsert(check)
        failures = [check.kind for check in checks if check.required and check.passed is not True]
        locally_repairable = {
            "min_evidence", "citation_integrity", "required_section", "claim_support",
            "report_consistency", "source_diversity", "source_match", "evidence_card_coverage",
        }
        return ContractVerdict(
            passed=not failures,
            recoverable=bool(failures) and set(failures).issubset(locally_repairable),
            checks=checks,
            failures=failures,
        )
