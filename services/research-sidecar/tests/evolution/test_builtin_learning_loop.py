import json

import pytest
import pytest_asyncio

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.evolution import PromotionPolicy, SkillEvaluator, SkillLearningService, SkillRegistry, SkillSpec
from deepresearch_agent.evolution.review_agents import _normalize_skill_proposal
from deepresearch_agent.evolution.review_schema import ReviewPack, SkillProposal
from deepresearch_agent.evolution.validators import ProposalValidators
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.contracts import ContractCheckData
from deepresearch_agent.harness.run_context import RunContext
from deepresearch_agent.harness.workflow import PlanExecuteReportDriver
from deepresearch_agent.persistence import Database
from deepresearch_agent.persistence.models import ToolCallModel
from deepresearch_agent.persistence.repositories import (
    AuditRepository, ContractRepository, LearningReviewRepository, RunRepository,
    SessionRepository, SkillRepository,
)
from deepresearch_agent.persistence.repositories.utils import utc_now_iso


class JsonLLM:
    async def ainvoke(self, prompt):
        if "Skill Critic" in prompt:
            return type("Response", (), {"content": json.dumps({
                "decision": "pass",
                "scores": {"grounding": .9, "generalizability": .9, "safety": 1, "cost_control": .9, "consistency": .9},
                "blocking_issues": [], "revision_instructions": [], "unsupported_rule_refs": [], "conflict_refs": [],
            })})()
        return type("Response", (), {"content": json.dumps({
            "decision": "create", "title": "GraphRAG 证据研究", "rationale": "验证轨迹包含可复用流程",
            "name": "graphrag-evidence-workflow", "proposed_version": "0.1.0",
            "description": "使用私域证据完成可验证研究报告的流程技能。",
            "applicability": {"source_modes": ["graphrag"]}, "triggers": ["研究报告"],
            "inputs": ["研究问题"], "rules": ["拆解研究问题", "同源检索证据", "按证据生成报告"],
            "anti_patterns": ["无新增证据时重复检索"], "stop_conditions": ["达到 Run 预算时停止"],
            "verification": ["citation_integrity", "claim_support"], "fallback": "证据不足时报告局限。",
            "allowed_tools": ["local_search"], "limitations": ["不得跨来源"],
            "machine_policy": {"permissions": {"allowed_tools": ["local_search"], "allowed_sources": ["graphrag"]}, "budgets": {"max_retries": 2}},
            "support_files": [], "trace_refs": ["tool_call:call-one"],
        }, ensure_ascii=False)})()


class RecordingEvents:
    def __init__(self):
        self.items = []

    async def publish(self, run_id, event_type, *, stage=None, payload=None):
        self.items.append({"run_id": run_id, "event_type": event_type, "stage": stage, "payload": payload or {}})


class ReviseToIgnoreLLM:
    def __init__(self):
        self.proposals = 0

    async def ainvoke(self, prompt):
        if "Skill Critic" in prompt:
            return type("Response", (), {"content": json.dumps({
                "decision": "revise", "scores": {"grounding": .8}, "blocking_issues": [],
                "revision_instructions": ["没有稳定增量时忽略"], "unsupported_rule_refs": [], "conflict_refs": [],
            })})()
        self.proposals += 1
        if self.proposals > 1:
            return type("Response", (), {"content": json.dumps({"decision": "ignore", "rationale": "修订后确认没有可复用增量"}, ensure_ascii=False)})()
        return await JsonLLM().ainvoke(prompt)


@pytest_asyncio.fixture
async def env(tmp_path):
    database = Database(f"sqlite+aiosqlite:///{(tmp_path / 'learning.db').as_posix()}")
    await database.create_schema()
    skills = SkillRepository(database)
    registry = SkillRegistry(tmp_path / "skills", skills)
    yield database, skills, registry
    await database.close()


async def completed_run(database):
    session = await SessionRepository(database).create(SessionCreate(title="learn"))
    message, run, _ = await RunRepository(database).create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="写一份详细研究报告", client_message_id="learn-1"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.PLAN_EXECUTE_REPORT),
    )
    now = utc_now_iso()
    async with database.transaction() as db:
        db.add(ToolCallModel(tool_call_id="call-one", run_id=run.run_id, task_id=None, tool_name="local_search", source_mode="graphrag", status="completed", args_json='{"query":"a"}', result_json="{}", created_at=now, completed_at=now))
        db.add(ToolCallModel(tool_call_id="call-two", run_id=run.run_id, task_id=None, tool_name="local_search", source_mode="graphrag", status="completed", args_json='{"query":"b"}', result_json="{}", created_at=now, completed_at=now))
    await ContractRepository(database).upsert(ContractCheckData(check_id="check-learning", run_id=run.run_id, kind="source_match", verifier="test", verifier_version="1", passed=True))
    await RunRepository(database).complete_verified(run.run_id, assistant_content="# report", usage={})
    return await RunRepository(database).get(run.run_id)


@pytest.mark.asyncio
async def test_background_review_creates_traceable_candidate(env):
    database, skills, registry = env
    run = await completed_run(database)
    events = RecordingEvents()
    service = SkillLearningService(
        database, LearningReviewRepository(database), skills, registry,
        proposer_llm=JsonLLM(), critic_llm=JsonLLM(), events=events, enabled=True,
    )
    job = await service.enqueue_for_run(run.run_id)
    await service._tasks[job.review_id]
    saved = await LearningReviewRepository(database).get(job.review_id)
    assert saved.status == "completed" and saved.candidate_id
    candidate = await skills.get_candidate(saved.candidate_id)
    payload = json.loads(candidate.payload_json)
    assert payload["review_id"] == job.review_id
    assert payload["proposal"]["trace_refs"] == ["tool_call:call-one"]
    assert payload["machine_policy"]["budgets"]["max_retries"] == 2
    event_types = {item["event_type"] for item in events.items}
    assert {"learning.review_pack.built", "skill.proposal.created", "skill.critic.completed", "skill.validation.completed", "skill.candidate.created"}.issubset(event_types)


@pytest.mark.asyncio
async def test_revision_to_ignore_completes_without_false_rejection(env):
    database, skills, registry = env
    run = await completed_run(database)
    llm = ReviseToIgnoreLLM()
    events = RecordingEvents()
    service = SkillLearningService(
        database, LearningReviewRepository(database), skills, registry,
        proposer_llm=llm, critic_llm=llm, events=events, enabled=True,
    )
    job = await service.enqueue_for_run(run.run_id)
    await service._tasks[job.review_id]
    saved = await LearningReviewRepository(database).get(job.review_id)
    assert saved.status == "completed" and saved.candidate_id is None
    assert json.loads(saved.checkpoint_json)["stage"] == "ignored_after_revision"
    assert any(item["event_type"] == "learning.review.ignored" for item in events.items)
    repository = LearningReviewRepository(database)
    await repository.update(saved.review_id, status="queued", reset_outputs=True)
    reset = await repository.get(saved.review_id)
    assert reset.proposal_json is None and reset.critic_json is None and reset.completed_at is None


def test_validator_blocks_permission_expansion():
    pack = ReviewPack(review_id="r", run_id="run", user_goal="q", workflow_mode="plan_execute_report", source_mode="graphrag", terminal_status="completed", artifact_refs=["run:run"])
    proposal = SkillProposal(
        decision="create", name="unsafe-expansion", proposed_version="0.1.0", description="unsafe expansion",
        rules=["a", "b", "c"], anti_patterns=["x"], stop_conditions=["y"], verification=["z"],
        allowed_tools=["tavily_search"], trace_refs=["run:run"],
    )
    result = ProposalValidators().validate(pack, proposal)
    assert not result.passed and any("扩大" in item for item in result.errors)


def test_actionable_proposal_rejects_empty_create_payload():
    with pytest.raises(ValueError, match="字段不完整"):
        SkillProposal(decision="create")


def test_proposer_normalizes_rich_rule_and_scalar_shapes():
    payload = _normalize_skill_proposal({
        "decision": "create", "name": "safe-web-review", "proposed_version": "0.1.0",
        "applicability": "official-source research", "rules": [
            {"rule": "cap retrieval", "trace_refs": ["run:r"]},
            {"rule": "filter sources", "trace_refs": ["evidence:e"]},
            {"rule": "cite claims", "trace_refs": ["contract:c"]},
        ],
        "anti_patterns": "unbounded search", "stop_conditions": "budget exhausted",
        "verification": "check citations", "limitations": "web only",
        "machine_policy": "do not expand tools",
    })

    proposal = SkillProposal.model_validate(payload)
    assert proposal.rules == ["cap retrieval", "filter sources", "cite claims"]
    assert proposal.trace_refs == ["run:r", "evidence:e", "contract:c"]
    assert proposal.verification == ["check citations"]


def test_validator_accepts_contract_trace_and_strips_orchestrator_label():
    pack = ReviewPack(
        review_id="r", run_id="run", user_goal="q", workflow_mode="plan_execute_report",
        source_mode="web", terminal_status="completed", artifact_refs=["run:run"],
        completion_contract={"citation_integrity": {"passed": True, "ref": "contract:c1"}},
    )
    proposal = SkillProposal(
        decision="create", name="safe-web-skill", proposed_version="0.1.0", description="safe web skill",
        rules=["a", "b", "c"], anti_patterns=["x"], stop_conditions=["y"], verification=["z"],
        allowed_tools=["web_search", "deep_research"], trace_refs=["run:run", "contract:c1"],
    )
    result = ProposalValidators().validate(pack, proposal)
    assert result.passed and any("编排标签" in item for item in result.warnings)


@pytest.mark.asyncio
async def test_real_replay_gate_and_staged_promotion(env):
    database, skills, registry = env
    run = await completed_run(database)
    skill = SkillSpec(
        name="staged-research", description="真实回放后经过 Shadow 和 Canary 的研究技能。", version="0.1.0",
        source_modes=["graphrag"], created_from_runs=[run.run_id], triggers=["研究报告"], inputs=["问题"],
        steps=["计划", "检索", "报告"], allowed_tools=["local_search"], fallback="停止并报告。",
        verification=["citation_integrity"], anti_patterns=["重复"], stop_conditions=["预算耗尽"],
        machine_policy={"permissions": {"allowed_tools": ["local_search"], "allowed_sources": ["graphrag"]}},
    )
    candidate = await registry.register_candidate(run_id=run.run_id, spec=skill, eval_cases=[
        {"query": f"研究报告 {index}", "source_mode": "graphrag", "workflow_mode": "plan_execute_report"}
        for index in range(3)
    ])

    async def runner(**kwargs):
        return {"completed": True, "citation_integrity": 1, "claim_support": 1, "tool_policy_violations": 0, "source_leakage": 0, "safety_passed": True, "llm_tokens": 100, "wall_time_seconds": 1}

    progress = []
    result = await SkillEvaluator(skills, case_runner=runner).evaluate(candidate.candidate_id, progress=lambda item: progress.append(item))
    assert result.status == "passed" and json.loads(result.metrics_json)["real_replay"] is True
    assert sum(item["phase"] == "arm_completed" for item in progress) == 6
    assert progress[-1]["phase"] == "evaluation_completed"
    policy = PromotionPolicy(skills, registry, AuditRepository(database), require_real_replay=True, staged=True, canary_percent=5)
    shadow = await policy.promote(name=skill.name, version=skill.version, candidate_id=candidate.candidate_id, human_approved=True)
    assert shadow.status == "shadow"
    canary = await policy.advance(name=skill.name, version=skill.version, target_stage="canary", human_approved=True)
    assert canary.status == "canary"
    for _ in range(3):
        monitored = await policy.observe_run(name=skill.name, version=skill.version, succeeded=True)
        assert monitored.status == "canary"
    active = await policy.advance(name=skill.name, version=skill.version, target_stage="active", human_approved=True)
    assert active.status == "active"


@pytest.mark.asyncio
async def test_canary_regression_auto_suspends(env):
    database, skills, registry = env
    run = await completed_run(database)
    skill = SkillSpec(
        name="canary-breaker", description="验证 Canary 在线退化时自动暂停的研究技能。", version="0.1.0",
        source_modes=["graphrag"], created_from_runs=[run.run_id], triggers=["研究"], inputs=["问题"],
        steps=["计划", "检索", "报告"], allowed_tools=["local_search"], fallback="停止并报告。",
        verification=["citation_integrity"], anti_patterns=["重复"], stop_conditions=["预算耗尽"],
    )
    candidate = await registry.register_candidate(run_id=run.run_id, spec=skill, eval_cases=[{}, {}, {}])
    await SkillEvaluator(skills).evaluate(candidate.candidate_id)
    policy = PromotionPolicy(skills, registry, AuditRepository(database), staged=True, canary_percent=5)
    await policy.promote(name=skill.name, version=skill.version, candidate_id=candidate.candidate_id, human_approved=True)
    await policy.advance(name=skill.name, version=skill.version, target_stage="canary", human_approved=True)
    assert (await policy.observe_run(name=skill.name, version=skill.version, succeeded=False, safety_violation=True)).status == "suspended"


def test_plan_execute_driver_injects_policy_into_all_stage_contexts():
    context = RunContext(
        run_id="run-policy", session_id="session-policy", trigger_message_id="message-policy",
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.PLAN_EXECUTE_REPORT,
        status="planning", original_query="研究问题", resolved_query="研究问题",
        context_snapshot={"selected_skill": {
            "name": "bounded-policy", "version": "1.0.0", "content": "skill",
            "allowed_tools": ["local_search"],
            "machine_policy": {
                "planner": {"required_plan_rules": ["先拆解"]},
                "worker": {"max_retries": 2}, "reflection": {"recovery_rules": ["证据不足时补检索"]},
                "reporter": {"section_context_policy": {"max_cards": 10}},
                "verifier": {"required_checks": ["citation_integrity"]},
                "permissions": {"allowed_tools": ["local_search"], "allowed_sources": ["graphrag"]},
            },
        }},
    )
    driver = PlanExecuteReportDriver(context, object())
    assert "ACTIVE SKILL POLICY" in driver.state.input
    assert driver.state.context_snapshot["skill_policy_consumers"] == ["planner", "worker", "reflection", "reporter", "verifier"]
    assert driver.state.context_snapshot["active_skill_policy"]["worker"]["max_retries"] == 2
