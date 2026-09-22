import pytest
import pytest_asyncio

from backend.app.schemas import MessageCreate, RunCreate, RunEventCreate, SessionCreate
from deepresearch_agent.evaluation import EvaluationLabels, EvaluationService, retrieval_metrics
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.contracts import ContractCheckData, EvidenceData
from deepresearch_agent.persistence import Database
from deepresearch_agent.persistence.repositories import (
    CheckpointRepository,
    ContractRepository,
    EvidenceRepository,
    EventRepository,
    RunRepository,
    SessionRepository,
)


@pytest_asyncio.fixture
async def database(tmp_path):
    database = Database(f"sqlite+aiosqlite:///{(tmp_path / 'evaluation.db').as_posix()}")
    await database.create_schema()
    yield database
    await database.close()


def test_retrieval_metrics_are_rank_sensitive_and_deduplicate_ids():
    result = retrieval_metrics(["noise", "gold-a", "gold-a", "gold-b"], {"gold-a", "gold-b"}, k=3)
    assert result.hits == 2
    assert result.precision_at_k == pytest.approx(2 / 3)
    assert result.recall_at_k == 1.0
    assert result.reciprocal_rank == 0.5
    assert 0 < result.ndcg_at_k < 1


@pytest.mark.asyncio
async def test_run_and_summary_metrics_come_from_durable_trajectory(database):
    session = await SessionRepository(database).create(SessionCreate(title="evaluation"))
    _, run, _ = await RunRepository(database).create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="研究问题", client_message_id="eval-1"),
        RunCreate(
            session_id=session.session_id,
            trigger_message_id="atomic",
            source_mode=SourceMode.GRAPHRAG,
            workflow_mode=WorkflowMode.DEEP_RESEARCH,
        ),
    )
    await RunRepository(database).update_status(run.run_id, status="context_building", current_stage="context_building")
    await EvidenceRepository(database).upsert(EvidenceData(
        evidence_id="ev_gold_a",
        run_id=run.run_id,
        source_mode=SourceMode.GRAPHRAG,
        provider="local_search",
        source_id="gold-a",
        summary="supporting evidence",
        content_hash="a" * 64,
        score=0.9,
    ))
    contracts = ContractRepository(database)
    for kind in ("citation_integrity", "claim_support", "source_match"):
        await contracts.upsert(ContractCheckData(
            check_id=f"contract_{run.run_id}_{kind}",
            run_id=run.run_id,
            kind=kind,
            verifier="test",
            verifier_version="1",
            passed=True,
        ))
    await CheckpointRepository(database).save(run.run_id, "verifying", {"status": "verifying"})
    await EventRepository(database).append(RunEventCreate(run_id=run.run_id, event_type="plan.replanning", stage="replanning"))
    await EventRepository(database).append(RunEventCreate(run_id=run.run_id, event_type="run.resumed", stage="executing"))
    await RunRepository(database).complete_verified(
        run.run_id,
        assistant_content="# 报告\n\n结论 [ev_gold_a]",
        usage={"usage": {"llm_tokens": 120, "tool_calls": 2, "prefix_cache_hit_tokens": 80, "prefix_cache_miss_tokens": 20}},
    )

    service = EvaluationService(database)
    labels = EvaluationLabels(
        relevant_source_ids=["gold-a", "gold-b"],
        semantic_claim_support_rate=0.9,
        report_quality_score=4.0,
    )
    evaluated = await service.evaluate_run(run.run_id, labels=labels, retrieval_k=2)
    assert evaluated.verified_completion is True
    assert evaluated.first_pass_completion is False
    assert evaluated.citation_validity == 1.0
    assert evaluated.recovery_succeeded is True
    assert evaluated.retrieval["recall_at_k"] == 0.5
    assert evaluated.prefix_cache_hit_rate == 0.8

    summary = await service.summarize(run_ids=[run.run_id], labels_by_run={run.run_id: labels})
    assert summary.verified_completion_rate == 1.0
    assert summary.replan_recovery_rate == 1.0
    assert summary.recovery_success_rate == 1.0
    assert summary.tokens_per_verified_run == 120
    assert summary.semantic_claim_support_rate == 0.9
