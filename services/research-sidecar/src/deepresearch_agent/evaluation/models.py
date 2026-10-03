"""Typed evaluation inputs and outputs."""

from __future__ import annotations

from pydantic import BaseModel, Field


class EvaluationLabels(BaseModel):
    """Optional human/gold labels; absent labels never become synthetic scores."""

    relevant_source_ids: list[str] = Field(default_factory=list)
    expected_honest_failure: bool | None = None
    semantic_claim_support_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    report_quality_score: float | None = Field(default=None, ge=1.0, le=5.0)


class RunEvaluation(BaseModel):
    run_id: str
    status: str
    source_mode: str
    workflow_mode: str

    verified_completion: bool
    first_pass_completion: bool
    required_contract_pass_rate: float
    required_contract_total: int
    contract_results: dict[str, bool | None]

    citation_count: int
    valid_citation_count: int
    citation_validity: float | None
    claim_support_proxy: float | None
    claim_support_measurement: str = "deterministic_contract_proxy"
    semantic_claim_support_rate: float | None = None
    report_quality_score: float | None = None
    honest_failure: bool | None = None

    evidence_count: int
    independent_source_count: int
    evidence_redundancy_rate: float
    source_leakage_detected: bool
    retrieval: dict | None = None

    retry_count: int
    replan_count: int
    recovery_attempted: bool
    recovery_succeeded: bool | None
    checkpoint_count: int
    checkpoint_integrity_rate: float | None
    tool_call_count: int
    failed_tool_call_count: int
    duplicate_tool_call_fingerprints: int
    duplicate_side_effect_rate: float
    task_count: int

    latency_ms: float | None
    llm_tokens: int
    tool_calls_reported: int
    prefix_cache_hit_rate: float | None


class EvaluationSummary(BaseModel):
    run_count: int
    verified_completion_rate: float
    first_pass_completion_rate: float
    mean_required_contract_pass_rate: float
    citation_validity: float | None
    semantic_claim_support_rate: float | None
    mean_report_quality_score: float | None
    honest_failure_rate: float | None
    source_leakage_rate: float
    evidence_redundancy_rate: float

    recovery_attempt_count: int
    recovery_success_rate: float | None
    replan_attempt_count: int
    replan_recovery_rate: float | None
    checkpoint_integrity_rate: float | None
    duplicate_side_effect_rate: float

    latency_p50_ms: float | None
    latency_p95_ms: float | None
    tokens_per_verified_run: float | None
    mean_tool_calls_per_run: float

    retrieval_precision_at_k: float | None
    retrieval_recall_at_k: float | None
    retrieval_mrr: float | None
    retrieval_ndcg_at_k: float | None
    runs: list[RunEvaluation] = Field(default_factory=list)
