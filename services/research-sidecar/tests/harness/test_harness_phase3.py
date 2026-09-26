import json
import asyncio

import pytest
import pytest_asyncio

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.agents.multi_agent.core.execution_record import ExecutionMetadata, ExecutionRecord, ToolCall
from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalMetadata, RetrievalResult
from deepresearch_agent.harness import RunStatus, SourceMode, WorkflowMode
from deepresearch_agent.harness.budgets import BudgetExceeded, BudgetLimits, BudgetManager
from deepresearch_agent.harness.checkpoints import CheckpointManager
from deepresearch_agent.harness.contracts import ContractEvaluator
from deepresearch_agent.harness.evidence import EvidenceLedger
from deepresearch_agent.harness.run_context import RunContext
from deepresearch_agent.harness.runtime import HarnessRuntime
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.harness.recovery import classify_verification_failures
from deepresearch_agent.harness.verifiers.deterministic import DeterministicVerifiers
from deepresearch_agent.harness.state_machine import InvalidTransition, StateMachine
from deepresearch_agent.persistence import ArtifactStore, Database
from deepresearch_agent.persistence.repositories import (
    ArtifactRepository, CheckpointRepository, ContractRepository, EventRepository,
    EvidenceRepository, MessageRepository, PlanTaskToolRepository, RunRepository,
    SessionRepository,
)


@pytest_asyncio.fixture
async def database(tmp_path):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'stage3.db').as_posix()}")
    await db.create_schema()
    yield db
    await db.close()


async def create_run(
    database, *, budget=None,
    source_mode=SourceMode.GRAPHRAG,
    workflow_mode=WorkflowMode.DEEP_RESEARCH,
    min_evidence=1,
):
    session = await SessionRepository(database).create(SessionCreate(title="stage3"))
    message, run, _ = await RunRepository(database).create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="请给出有证据的研究报告", client_message_id=f"client-{session.session_id}"),
        RunCreate(
            session_id=session.session_id, trigger_message_id="atomic",
            source_mode=source_mode, workflow_mode=workflow_mode,
            config_snapshot={"min_evidence": min_evidence}, budget=budget or BudgetLimits().model_dump(),
        ),
    )
    return message, run


class FakeDriver:
    execute_calls = 0
    plan_calls = 0
    report_calls = 0

    def __init__(self, context, *, dangling=False, tool_count=1, plan_task_count=1, token_count=0):
        self.context = context
        restored = context.workflow_state
        self.executed = bool(restored.get("executed"))
        self.repaired = bool(restored.get("repaired"))
        self.dangling = dangling
        self.tool_count = tool_count
        self.plan_task_count = plan_task_count
        self.token_count = token_count
        self.mode = context.source_mode.value
        self.tool_name = "tavily_search" if self.mode == "web" else "local_search"
        self.results = [
            RetrievalResult(
                result_id=item_id, granularity="Chunk", evidence=f"evidence-{index}",
                metadata=RetrievalMetadata(
                    source_id=(f"https://example.com/source-{index}" if self.mode == "web" else f"doc-{index}"),
                    source_type=("webpage" if self.mode == "web" else "chunk"),
                    title=f"source-{index}",
                    url=(f"https://example.com/source-{index}" if self.mode == "web" else None),
                    content_hash=f"{'a' if index == 1 else 'b'}" * 64,
                ),
                source=self.tool_name, source_mode=self.mode, score=0.9,
            )
            for index, item_id in enumerate(("raw-1", "raw-2"), start=1)
        ]
        for result, saved in zip(self.results, restored.get("results", [])):
            result.result_id = saved["result_id"]
        self._report = restored.get("report")

    async def plan(self, failures=None):
        type(self).plan_calls += 1
        self.failures = failures or []

    async def execute(self):
        if not self.executed:
            type(self).execute_calls += 1
            self.executed = True

    async def report(self):
        type(self).report_calls += 1
        dangling = " [ev_missing]" if self.dangling and not self.repaired else ""
        self._report = f"# 研究报告\n\n结论内容已有充分说明 [{self.results[0].result_id}]{dangling}\n\n## 方法\n\n基于证据。\n\n## 局限\n\n当前报告仅直接引用一个来源。"
        return self._report

    async def repair_report(self, failures):
        self.repaired = True
        return set(failures).issubset({"citation_integrity", "required_section", "source_diversity"})

    def snapshot(self):
        return {"executed": self.executed, "repaired": self.repaired, "report": self._report, "results": [item.to_dict() for item in self.results]}

    def execution_records(self):
        calls = [ToolCall(tool_name=self.tool_name, tool_call_id=f"call-{self.context.run_id}-{index}", source_mode=self.mode, args={"query": "safe"}, result={"ok": True}) for index in range(self.tool_count)]
        return [ExecutionRecord(task_id=f"task-{self.context.run_id}", session_id=self.context.session_id, worker_type="fake", tool_calls=calls, evidence=self.results, metadata=ExecutionMetadata(worker_type="fake", token_usage={"total": self.token_count}, tool_calls_count=len(calls), evidence_count=len(self.results)))]

    def evidence_results(self):
        return [(f"task-{self.context.run_id}", f"call-{self.context.run_id}-0", self.tool_name, item) for item in self.results]

    def report_consistency(self):
        return True

    def plan_record(self):
        tasks = [
            {"task_id": (f"task-{self.context.run_id}" if index == 0 else f"task-{self.context.run_id}-{index}"), "task_type": "deep_research", "source_mode": self.mode, "status": "pending", "description": f"research-{index}"}
            for index in range(self.plan_task_count)
        ]
        return ({"plan_id": f"plan-{self.context.run_id}", "status": "executing", "tasks": tasks}, tasks)


class RetryOnceDriver(FakeDriver):
    attempts = 0

    async def execute(self):
        type(self).attempts += 1
        if type(self).attempts == 1:
            raise AppError(ErrorCode.RETRIEVAL_TIMEOUT, "temporary timeout", retryable=True)
        await super().execute()


class ConsistencyRepairDriver(FakeDriver):
    async def repair_report(self, failures):
        if "report_consistency" not in failures:
            return await super().repair_report(failures)
        self.repaired = True
        return True

    def report_consistency(self):
        return self.repaired


class NeverConsistentDriver(FakeDriver):
    async def repair_report(self, failures):
        self.repaired = True
        return True

    def report_consistency(self):
        return False


class ZeroEvidenceDriver(FakeDriver):
    execute_calls = 0
    report_calls = 0

    def __init__(self, context):
        super().__init__(context)
        self.results = []
        self.zero_executions = int(context.workflow_state.get("zero_executions", 0))

    async def execute(self):
        type(self).execute_calls += 1
        self.zero_executions += 1

    async def report(self):
        type(self).report_calls += 1
        return "# 不应生成"

    def snapshot(self):
        return {"zero_executions": self.zero_executions, "results": []}

    def execution_records(self):
        index = self.zero_executions
        return [ExecutionRecord(
            task_id=f"task-{self.context.run_id}-{index}",
            session_id=self.context.session_id,
            worker_type="fake",
            tool_calls=[ToolCall(
                tool_name=self.tool_name,
                tool_call_id=f"call-{self.context.run_id}-{index}",
                source_mode=self.mode,
                args={"query": "no-match"},
                result={"ok": True},
            )],
            evidence=[],
            metadata=ExecutionMetadata(worker_type="fake", tool_calls_count=1, evidence_count=0),
        )]

    def evidence_results(self):
        return []

    def plan_record(self):
        next_index = self.zero_executions + 1
        task_id = f"task-{self.context.run_id}-{next_index}"
        tasks = [{
            "task_id": task_id,
            "task_type": "local_search",
            "source_mode": self.mode,
            "status": "pending",
            "description": "no evidence probe",
        }]
        return ({"plan_id": f"plan-{self.context.run_id}-{next_index}", "status": "executing", "tasks": tasks}, tasks)


def build_runtime(database, tmp_path, factory, *, prefix_tracker=None):
    return HarnessRuntime(
        run_repository=RunRepository(database), message_repository=MessageRepository(database),
        event_repository=EventRepository(database), checkpoint_repository=CheckpointRepository(database),
        evidence_repository=EvidenceRepository(database), contract_repository=ContractRepository(database),
        trajectory_repository=PlanTaskToolRepository(database), workflow_factory=factory,
        artifact_store=ArtifactStore(tmp_path / "artifacts"), artifact_repository=ArtifactRepository(database),
        prefix_tracker=prefix_tracker,
    )


def test_state_machine_rejects_illegal_and_unverified_completion():
    machine = StateMachine()
    with pytest.raises(InvalidTransition):
        machine.validate(RunStatus.QUEUED, RunStatus.COMPLETED, contract_passed=True)
    with pytest.raises(InvalidTransition):
        machine.validate(RunStatus.VERIFYING, RunStatus.COMPLETED)
    machine.validate(RunStatus.VERIFYING, RunStatus.COMPLETED, contract_passed=True)


def test_verification_failure_routing_is_complete():
    assert classify_verification_failures(["report_consistency"]).action == "repair_report"
    assert classify_verification_failures(["citation_integrity"]).action == "repair_report"
    assert classify_verification_failures(["source_match"]).action == "replan"
    assert classify_verification_failures(["claim_support", "report_consistency"]).action == "repair_report"
    assert classify_verification_failures(["citation_integrity", "claim_support"]).action == "repair_report"
    assert classify_verification_failures(["min_evidence", "claim_support"]).action == "replan"


def test_budget_manager_enforces_tool_retry_and_replan_limits(monkeypatch):
    manager = BudgetManager(BudgetLimits(max_tool_calls=1, max_task_retries=1, max_replans=1))
    manager.consume_tool()
    with pytest.raises(BudgetExceeded):
        manager.consume_tool()
    manager = BudgetManager(BudgetLimits(max_task_retries=1))
    manager.consume_retry()
    with pytest.raises(BudgetExceeded):
        manager.consume_retry()
    manager = BudgetManager(BudgetLimits(max_replans=1))
    manager.consume_replan()
    with pytest.raises(BudgetExceeded):
        manager.consume_replan()
    manager = BudgetManager(BudgetLimits(max_plan_tasks=1, max_llm_tokens=10))
    with pytest.raises(BudgetExceeded):
        manager.observe_plan_tasks(2)
    manager = BudgetManager(BudgetLimits(max_llm_tokens=10))
    with pytest.raises(BudgetExceeded):
        manager.observe_tokens(11)
    manager = BudgetManager(BudgetLimits(max_tavily_calls=1))
    manager.consume_tool(tavily=True)
    with pytest.raises(BudgetExceeded):
        manager.consume_tool(tavily=True)
    from deepresearch_agent.harness import budgets as budget_module
    ticks = iter((100.0, 102.0))
    monkeypatch.setattr(budget_module.time, "monotonic", lambda: next(ticks))
    manager = BudgetManager(BudgetLimits(wall_time_seconds=1))
    with pytest.raises(BudgetExceeded) as exc_info:
        manager.assert_available()
    assert str(exc_info.value) == "预算耗尽: wall_time_seconds=2.00 超过上限 1"
    assert BudgetLimits().wall_time_seconds == 1800
    assert BudgetLimits().max_llm_tokens == 200000
    ticks = iter((2000.0, 2900.42))
    monkeypatch.setattr(budget_module.time, "monotonic", lambda: next(ticks))
    manager = BudgetManager(BudgetLimits())
    manager.assert_available()
    assert manager.usage.elapsed_seconds == pytest.approx(900.42)
    ticks = iter((3000.0, 3000.1))
    monkeypatch.setattr(budget_module.time, "monotonic", lambda: next(ticks))
    manager = BudgetManager(BudgetLimits())
    manager.observe_tokens(102142)
    assert manager.usage.llm_tokens == 102142


def test_token_usage_total_does_not_double_count_provider_total():
    assert HarnessRuntime._token_usage_total({"prompt_tokens": 60, "completion_tokens": 10, "total_tokens": 70}) == 70
    assert HarnessRuntime._token_usage_total({"prompt_tokens": 60, "completion_tokens": 10}) == 70


@pytest.mark.asyncio
async def test_web_deep_research_bypasses_answer_cache_and_replan_reexecutes():
    from deepresearch_agent.harness.workflow import DeepResearchDriver

    class Agent:
        def __init__(self):
            self.calls = []
            self.research_tool = type("Tool", (), {"provider_results": [], "provider_calls": []})()

        def ask(self, query, session_id, *, bypass_cache=False):
            self.calls.append(bypass_cache)
            return "answer"

    context = RunContext(
        run_id="run-web-cache", session_id="ses-web-cache", trigger_message_id="msg-web-cache",
        source_mode=SourceMode.WEB, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=RunStatus.QUEUED, original_query="current web query", budget_limits=BudgetLimits(),
    )
    agent = Agent()
    driver = DeepResearchDriver(context, agent)
    await driver.plan()
    await driver.execute()
    await driver.plan(["min_evidence"])
    await driver.execute()
    assert agent.calls == [True, True]


@pytest.mark.asyncio
async def test_deep_research_report_does_not_attach_unrelated_citations():
    from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalMetadata, RetrievalResult
    from deepresearch_agent.harness.workflow import DeepResearchDriver

    class Agent:
        research_tool = type("Tool", (), {"provider_results": [], "provider_calls": []})()

    context = RunContext(
        run_id="run-writer-boundary", session_id="ses-writer-boundary", trigger_message_id="msg-writer-boundary",
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=RunStatus.REPORTING, original_query="question", budget_limits=BudgetLimits(),
    )
    driver = DeepResearchDriver(context, Agent())
    driver.answer = "这是 Writer 没有引用的事实性陈述。"
    driver.results = [RetrievalResult(
        result_id="ev_unrelated", granularity="Chunk", evidence="另一条原文",
        source="hybrid_search", source_mode="graphrag", score=0.8,
        metadata=RetrievalMetadata(source_id="chunk-1", source_type="chunk"),
    )]

    report = await driver.report()

    assert "[ev_unrelated]" not in report


@pytest.mark.asyncio
async def test_deep_report_normalizes_existing_ids_and_discloses_cited_source_scope():
    from types import SimpleNamespace
    from deepresearch_agent.harness.workflow import DeepResearchDriver
    context = RunContext(run_id="run-format", session_id="ses-format", trigger_message_id="msg-format",
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=RunStatus.REPORTING, original_query="question", budget_limits=BudgetLimits())
    driver = DeepResearchDriver(context, SimpleNamespace(research_tool=None))
    driver.results = [RetrievalResult(result_id=f"ev_{i}", granularity="Chunk",
        evidence="服务层不读取页面状态，所有网络协议由服务层处理。", source="hybrid_search",
        source_mode="graphrag", score=0.8,
        metadata=RetrievalMetadata(source_id=f"chunk-{i}", source_type="chunk",
            extra={"document_id": f"doc-{i}"})) for i in range(2)]
    driver.answer = "服务层不读取页面状态，所有网络协议由服务层处理 `<ev_0>`。"
    report = await driver.report()
    assert "[ev_0]" in report and "<ev_0>" not in report
    assert "局限" in report  # Two retrieved documents, only one actually cited.
    verifier = DeterministicVerifiers(
        run_id=context.run_id, source_mode=context.source_mode, report=report,
        evidence=[{"evidence_id": r.result_id, "source_id": r.metadata.source_id,
            "metadata_json": {"extra": r.metadata.extra}} for r in driver.results])
    assert verifier.citation_integrity().passed and verifier.claim_support().passed
    assert verifier.source_diversity().passed
    driver.answer += "\n另一条没有原文支持的结论不能自动获得引用。"
    report = await driver.report()
    assert "另一条没有原文支持的结论不能自动获得引用。 [" not in report
    verifier.report = report
    assert not verifier.claim_support().passed
    driver.answer = "服务层不读取页面状态，所有网络协议由服务层处理 <ev_foreign>。"
    verifier.report = await driver.report()
    assert not verifier.citation_integrity().passed


@pytest.mark.asyncio
async def test_real_deep_driver_repairs_uncited_claim_without_retrieval():
    from types import SimpleNamespace
    from deepresearch_agent.harness.workflow import DeepResearchDriver
    context = RunContext(run_id="run-repair", session_id="ses-repair", trigger_message_id="msg-repair",
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=RunStatus.REPORTING, original_query="question", budget_limits=BudgetLimits())
    driver = DeepResearchDriver(context, SimpleNamespace(research_tool=None))
    driver.results = [RetrievalResult(result_id="ev_a", granularity="Chunk",
        evidence="服务层只处理请求协议，不操作页面状态。", source="hybrid_search",
        source_mode="graphrag", score=0.8,
        metadata=RetrievalMetadata(source_id="doc-a", source_type="chunk"))]
    driver.answer = "未经证据支持的主张不能自动加上引用。"
    await driver.report()
    assert await driver.repair_report(["citation_integrity", "claim_support"])
    report = await driver.report()
    assert "未经证据支持" not in report
    assert "服务层只处理请求协议" in report and "[ev_a]" in report


@pytest.mark.asyncio
@pytest.mark.parametrize("repair_limit", [0, 1])
async def test_runtime_bounds_real_deep_driver_report_repair(database, tmp_path, repair_limit):
    from types import SimpleNamespace
    from deepresearch_agent.harness.workflow import DeepResearchDriver
    _, run = await create_run(database, budget=BudgetLimits(max_task_retries=repair_limit).model_dump())
    calls = []
    result = RetrievalResult(result_id="raw-1", granularity="Chunk",
        evidence="服务层只处理请求协议，不操作页面状态。", source="hybrid_search",
        source_mode="graphrag", score=0.8,
        metadata=RetrievalMetadata(source_id="doc-a", source_type="chunk"))
    class Agent:
        research_tool = SimpleNamespace(provider_results=[result], provider_calls=[])
        def ask(self, query, session_id, **kwargs):
            calls.append(query)
            return "这是一个没有引用且不能直接交付的结论。"
    runtime = build_runtime(database, tmp_path, lambda context, events=None: DeepResearchDriver(context, Agent(), events))
    finished = await runtime.execute_run(run.run_id)
    saved = await RunRepository(database).get(run.run_id)
    assert finished.status is (RunStatus.COMPLETED if repair_limit else RunStatus.FAILED), saved.error_message
    assert len(calls) == 1
    assert finished.budget_usage.task_retries == repair_limit
    assert finished.budget_usage.replans == 0
    if repair_limit:
        assert "这是一个没有引用" not in finished.report
        assert "服务层只处理请求协议" in finished.report


def test_real_deep_research_agent_ask_accepts_and_forwards_bypass_cache(monkeypatch):
    """真实 DeepResearchAgent.ask 必须接受并转发 bypass_cache（Web Run TypeError 回归）。

    早期回归只用自定义假 Agent（自带 bypass_cache 签名），漏掉了真实
    DeepResearchAgent 重写 ask() 时未转发参数导致的 TypeError。
    """
    from deepresearch_agent.agents.base import BaseAgent
    from deepresearch_agent.agents.deep_research_agent import DeepResearchAgent

    # 仅构造最小实例，避免 __init__ 初始化 DeepResearchTool 的外部依赖
    agent = DeepResearchAgent.__new__(DeepResearchAgent)
    agent.show_thinking = False
    agent.use_deeper_tool = False

    calls = []

    def fake_base_ask(self, query, thread_id="default", recursion_limit=None, *, bypass_cache=False):
        calls.append((query, thread_id, recursion_limit, bypass_cache))
        return "ok"

    monkeypatch.setattr(BaseAgent, "ask", fake_base_ask)
    assert agent.ask("q", "t", 5, bypass_cache=True) == "ok"
    assert calls[-1] == ("q", "t", 5, True)
    assert agent.ask("q2", "t2", bypass_cache=False) == "ok"
    assert calls[-1] == ("q2", "t2", None, False)


@pytest.mark.asyncio
async def test_required_contract_failure_never_completes(database):
    _, run = await create_run(database)
    evaluator = ContractEvaluator(ContractRepository(database))
    verdict = await evaluator.evaluate(run_id=run.run_id, source_mode="graphrag", report="# 空报告", evidence=[], consistency_passed=True)
    assert not verdict.passed
    with pytest.raises(ValueError):
        await RunRepository(database).complete_verified(run.run_id, assistant_content="bad", usage={})


@pytest.mark.asyncio
async def test_runtime_happy_path_persists_events_checkpoints_contract_and_message(database, tmp_path):
    FakeDriver.execute_calls = 0
    _, run = await create_run(database)
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    assert FakeDriver.execute_calls == 1
    events = await EventRepository(database).list_after(run.run_id)
    names = [event.event_type for event in events]
    assert {"run.started", "plan.created", "task.completed", "tool.completed", "evidence.added", "report.completed", "verification.completed", "run.completed"}.issubset(names)
    latest = await CheckpointRepository(database).latest(run.run_id)
    assert latest.stage == "completed" and CheckpointRepository.verify(latest)
    assert await ContractRepository(database).required_checks_passed(run.run_id)
    messages = await MessageRepository(database).list_for_session(run.session_id)
    assert [message.role for message in messages] == ["user", "assistant"]
    assert len(await EvidenceRepository(database).list_for_run(run.run_id)) == 2
    assert await database.foreign_key_violations() == []


@pytest.mark.asyncio
async def test_runtime_persists_completed_search_before_execute_finishes(database, tmp_path):
    started = asyncio.Event()
    finish = asyncio.Event()

    class SlowDriver(FakeDriver):
        async def execute(self):
            self.executed = True
            started.set()
            await finish.wait()

    _, run = await create_run(database)
    runtime = build_runtime(database, tmp_path, lambda ctx, events=None: SlowDriver(ctx))
    running = asyncio.create_task(runtime.execute_run(run.run_id))
    await started.wait()
    await asyncio.sleep(1.1)

    assert len(await EvidenceRepository(database).list_for_run(run.run_id)) == 2
    event_names = [item.event_type for item in await EventRepository(database).list_after(run.run_id)]
    assert "tool.completed" in event_names
    assert "task.completed" not in event_names

    finish.set()
    completed = await running
    assert completed.status is RunStatus.COMPLETED


@pytest.mark.asyncio
async def test_pause_after_planning_resumes_same_run_without_replanning(database, tmp_path):
    FakeDriver.plan_calls = 0
    FakeDriver.execute_calls = 0
    _, run = await create_run(database)

    class PauseAfterPlanDriver(FakeDriver):
        async def plan(self, failures=None):
            await super().plan(failures)
            await RunRepository(database).request_pause(self.context.run_id)

    first = await build_runtime(
        database, tmp_path, lambda ctx, events=None: PauseAfterPlanDriver(ctx),
    ).execute_run(run.run_id)
    assert first.status is RunStatus.PAUSED
    assert first.resume_from_status is RunStatus.EXECUTING
    stored_paused = await RunRepository(database).get(run.run_id)
    assert json.loads(stored_paused.config_snapshot_json)["pause_requested"] is False
    assert PauseAfterPlanDriver.plan_calls == 1
    assert PauseAfterPlanDriver.execute_calls == 0

    assert await RunRepository(database).resume(run.run_id)
    second = await build_runtime(
        database, tmp_path, lambda ctx, events=None: PauseAfterPlanDriver(ctx),
    ).execute_run(run.run_id)
    assert second.status is RunStatus.COMPLETED
    assert PauseAfterPlanDriver.plan_calls == 1
    assert PauseAfterPlanDriver.execute_calls == 1
    events = await EventRepository(database).list_after(run.run_id)
    assert [event.event_type for event in events].count("run.paused") == 1
    assert [event.event_type for event in events].count("run.resumed") == 1


@pytest.mark.asyncio
async def test_citation_failure_is_locally_repaired_with_bounded_retry(database, tmp_path):
    _, run = await create_run(database)
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx, dangling=True)).execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    events = await EventRepository(database).list_after(run.run_id)
    assert any(event.event_type == "run.retrying" for event in events)
    assert json.loads((await RunRepository(database).get(run.run_id)).usage_json)["usage"]["task_retries"] == 1


@pytest.mark.asyncio
async def test_report_consistency_failure_repairs_then_reverifies(database, tmp_path):
    _, run = await create_run(database)
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: ConsistencyRepairDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    events = await EventRepository(database).list_after(run.run_id)
    retry = next(event for event in events if event.event_type == "run.retrying")
    retry_payload = json.loads(retry.payload_json)
    assert retry_payload["recovery_action"] == "repair_report"
    assert retry_payload["attempt"] == 1
    verification_payloads = [json.loads(event.payload_json) for event in events if event.event_type == "verification.completed"]
    assert [item["passed"] for item in verification_payloads] == [False, True]


@pytest.mark.asyncio
async def test_report_consistency_exhaustion_fails_with_clear_reason(database, tmp_path):
    _, run = await create_run(database, budget=BudgetLimits(max_task_retries=2).model_dump())
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: NeverConsistentDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.FAILED
    stored = await RunRepository(database).get(run.run_id)
    assert "自动修复 2 次后仍未通过" in stored.error_message
    events = await EventRepository(database).list_after(run.run_id)
    verification_payloads = [json.loads(event.payload_json) for event in events if event.event_type == "verification.completed"]
    assert verification_payloads[-1]["attempts_exhausted"] is True
    assert verification_payloads[-1]["attempt"] == verification_payloads[-1]["max_attempts"] == 2
    assert json.loads(stored.usage_json)["usage"]["task_retries"] == 2


@pytest.mark.asyncio
async def test_zero_evidence_replans_once_then_fails_fast_without_report(database, tmp_path):
    ZeroEvidenceDriver.execute_calls = 0
    ZeroEvidenceDriver.report_calls = 0
    _, run = await create_run(
        database,
        budget=BudgetLimits(max_replans=2).model_dump(),
        source_mode=SourceMode.GRAPHRAG,
        workflow_mode=WorkflowMode.PLAN_EXECUTE_REPORT,
    )
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: ZeroEvidenceDriver(ctx)).execute_run(run.run_id)

    assert result.status is RunStatus.FAILED
    assert result.budget_usage.replans == 1
    assert ZeroEvidenceDriver.execute_calls == 2
    assert ZeroEvidenceDriver.report_calls == 0
    stored = await RunRepository(database).get(run.run_id)
    assert stored.error_code == "NO_SOURCE_EVIDENCE"
    assert "导入与该主题相关的私域资料" in stored.error_message
    events = await EventRepository(database).list_after(run.run_id)
    names = [event.event_type for event in events]
    assert names.count("source.coverage_checked") == 2
    assert names.count("plan.replanning") == 1
    assert "report.completed" not in names


@pytest.mark.asyncio
async def test_insufficient_evidence_for_detailed_report_fails_before_reporting(database, tmp_path):
    FakeDriver.report_calls = 0
    _, run = await create_run(
        database,
        budget=BudgetLimits(max_replans=2).model_dump(),
        source_mode=SourceMode.GRAPHRAG,
        workflow_mode=WorkflowMode.PLAN_EXECUTE_REPORT,
        min_evidence=3,
    )
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx)).execute_run(run.run_id)

    assert result.status is RunStatus.FAILED
    assert result.budget_usage.replans == 1
    assert FakeDriver.report_calls == 0
    stored = await RunRepository(database).get(run.run_id)
    assert stored.error_code == "INSUFFICIENT_SOURCE_EVIDENCE"
    assert "低于本报告所需的 3 条" in stored.error_message
    events = await EventRepository(database).list_after(run.run_id)
    coverage = [json.loads(event.payload_json) for event in events if event.event_type == "source.coverage_checked"]
    assert len(coverage) == 2
    assert coverage[-1]["evidence_count"] == 2
    assert coverage[-1]["minimum_evidence"] == 3
    assert "report.completed" not in [event.event_type for event in events]


@pytest.mark.asyncio
async def test_cancel_stops_before_new_tool_call(database, tmp_path):
    FakeDriver.execute_calls = 0
    _, run = await create_run(database)
    assert await RunRepository(database).request_cancel(run.run_id)
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.CANCELLED
    assert FakeDriver.execute_calls == 0


@pytest.mark.asyncio
async def test_tool_budget_exhaustion_is_terminal_and_not_completed(database, tmp_path):
    _, run = await create_run(database, budget=BudgetLimits(max_tool_calls=1).model_dump())
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx, tool_count=2)).execute_run(run.run_id)
    assert result.status is RunStatus.BUDGET_EXHAUSTED
    assert not await ContractRepository(database).required_checks_passed(run.run_id)


@pytest.mark.asyncio
async def test_plan_task_and_reported_token_budgets_are_enforced(database, tmp_path):
    FakeDriver.execute_calls = 0
    _, plan_run = await create_run(database, budget=BudgetLimits(max_plan_tasks=1).model_dump())
    plan_result = await build_runtime(
        database, tmp_path, lambda ctx, events=None: FakeDriver(ctx, plan_task_count=2)
    ).execute_run(plan_run.run_id)
    assert plan_result.status is RunStatus.BUDGET_EXHAUSTED
    assert FakeDriver.execute_calls == 0
    assert (await RunRepository(database).get(plan_run.run_id)).error_message.startswith("预算耗尽: plan_tasks=")

    _, token_run = await create_run(database, budget=BudgetLimits(max_llm_tokens=10).model_dump())
    token_result = await build_runtime(
        database, tmp_path, lambda ctx, events=None: FakeDriver(ctx, token_count=11)
    ).execute_run(token_run.run_id)
    assert token_result.status is RunStatus.BUDGET_EXHAUSTED
    assert token_result.budget_usage.llm_tokens == 11
    assert (await RunRepository(database).get(token_run.run_id)).error_message.startswith("预算耗尽: llm_tokens=")

    class PrefixUsage:
        def run_snapshot(self, run_id):
            return {"totals": {"requests": 1, "input_tokens": 8, "output_tokens": 3, "hit_tokens": 4, "miss_tokens": 4}}

    _, tracked_run = await create_run(database, budget=BudgetLimits(max_llm_tokens=10).model_dump())
    tracked_result = await build_runtime(
        database, tmp_path, lambda ctx, events=None: FakeDriver(ctx), prefix_tracker=PrefixUsage(),
    ).execute_run(tracked_run.run_id)
    assert tracked_result.status is RunStatus.BUDGET_EXHAUSTED
    assert tracked_result.budget_usage.llm_tokens == 11


@pytest.mark.asyncio
async def test_retryable_transport_error_retries_same_execution_once(database, tmp_path):
    RetryOnceDriver.attempts = 0
    _, run = await create_run(database)
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: RetryOnceDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    assert RetryOnceDriver.attempts == 2
    events = await EventRepository(database).list_after(run.run_id)
    assert {"run.retrying", "run.retry_resumed"}.issubset({event.event_type for event in events})


@pytest.mark.asyncio
async def test_interrupted_executing_checkpoint_resumes_without_reexecuting_completed_batch(database, tmp_path):
    FakeDriver.execute_calls = 0
    FakeDriver.plan_calls = 0
    message, run = await create_run(database)
    context = RunContext(
        run_id=run.run_id, session_id=run.session_id, trigger_message_id=message.message_id,
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=RunStatus.EXECUTING, original_query=message.content, budget_limits=BudgetLimits(),
        workflow_state={"executed": True, "results": []},
    )
    await CheckpointManager(CheckpointRepository(database)).save(context, "executing")
    await RunRepository(database).update_status(run.run_id, status="interrupted", current_stage="interrupted")
    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx)).execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    assert FakeDriver.execute_calls == 0
    assert FakeDriver.plan_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("checkpoint_status", "workflow_state", "expected_plan", "expected_execute", "expected_report"),
    [
        (RunStatus.PLANNING, {}, 0, 1, 1),
        (RunStatus.REPORTING, {"executed": True, "report": "# 研究报告\n\n结论 [raw-1]\n\n## 方法\n\n基于证据。", "results": []}, 0, 0, 0),
    ],
)
async def test_interrupted_stage_resumes_after_latest_safe_checkpoint(
    database, tmp_path, checkpoint_status, workflow_state,
    expected_plan, expected_execute, expected_report,
):
    FakeDriver.plan_calls = 0
    FakeDriver.execute_calls = 0
    FakeDriver.report_calls = 0
    message, run = await create_run(database)
    context = RunContext(
        run_id=run.run_id, session_id=run.session_id, trigger_message_id=message.message_id,
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status=checkpoint_status, original_query=message.content, budget_limits=BudgetLimits(),
        workflow_state=workflow_state,
        report=workflow_state.get("report"),
    )
    if checkpoint_status is RunStatus.REPORTING:
        prepared = FakeDriver(context)
        EvidenceLedger().assign(
            run_id=run.run_id, task_id=f"task-{run.run_id}",
            tool_call_id=f"call-{run.run_id}-0", provider="local_search",
            results=prepared.results,
        )
        context.workflow_state = prepared.snapshot()
        context.report = f"# 研究报告\n\n恢复后的结论已有证据支持 [{prepared.results[0].result_id}] [{prepared.results[1].result_id}]\n\n## 方法\n\n基于证据。"
        context.workflow_state["report"] = context.report
    await CheckpointManager(CheckpointRepository(database)).save(context, checkpoint_status.value)
    await RunRepository(database).update_status(run.run_id, status="interrupted", current_stage="interrupted")

    result = await build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx)).execute_run(run.run_id)

    assert result.status is RunStatus.COMPLETED
    assert FakeDriver.plan_calls == expected_plan
    assert FakeDriver.execute_calls == expected_execute
    assert FakeDriver.report_calls == expected_report
    resumed = [event for event in await EventRepository(database).list_after(run.run_id) if event.event_type == "run.resumed"]
    assert len(resumed) == 1


@pytest.mark.asyncio
async def test_startup_recovery_marks_active_run_without_lease_interrupted(database):
    from deepresearch_agent.harness.recovery import RecoveryManager

    _, run = await create_run(database)
    await RunRepository(database).update_status(run.run_id, status="planning", current_stage="planning")

    recoverable = await RecoveryManager(RunRepository(database)).scan(auto_resume=True)

    assert recoverable == [run.run_id]
    assert (await RunRepository(database).get(run.run_id)).status == "interrupted"
    events = await EventRepository(database).list_after(run.run_id)
    assert [event.event_type for event in events].count("run.interrupted") == 1


@pytest.mark.asyncio
async def test_final_assistant_message_is_idempotent(database, tmp_path):
    _, run = await create_run(database)
    runtime = build_runtime(database, tmp_path, lambda ctx, events=None: FakeDriver(ctx))
    result = await runtime.execute_run(run.run_id)
    assert result.status is RunStatus.COMPLETED
    message, created = await RunRepository(database).complete_verified(run.run_id, assistant_content=result.report, usage={})
    assert created is False and message.run_id == run.run_id
    messages = await MessageRepository(database).list_for_session(run.session_id)
    assert len([item for item in messages if item.role == "assistant"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("source_mode", [SourceMode.GRAPHRAG, SourceMode.WEB])
@pytest.mark.parametrize("workflow_mode", [WorkflowMode.DEEP_RESEARCH, WorkflowMode.PLAN_EXECUTE_REPORT])
@pytest.mark.parametrize("sample", range(3))
async def test_each_workflow_source_combination_has_three_complete_harness_samples(
    database, tmp_path, source_mode, workflow_mode, sample,
):
    _, run = await create_run(
        database, source_mode=source_mode, workflow_mode=workflow_mode,
    )
    result = await build_runtime(
        database, tmp_path / f"{source_mode.value}-{workflow_mode.value}-{sample}",
        lambda ctx, events=None: FakeDriver(ctx),
    ).execute_run(run.run_id)

    assert result.status is RunStatus.COMPLETED
    evidence = await EvidenceRepository(database).list_for_run(run.run_id)
    assert len(evidence) == 2
    assert {item.source_mode for item in evidence} == {source_mode.value}
    events = await EventRepository(database).list_after(run.run_id)
    stages = {event.stage for event in events}
    assert {"context_building", "planning", "executing", "reporting", "verifying", "completed"}.issubset(stages)
    assert await ContractRepository(database).required_checks_passed(run.run_id)
