import json

import pytest
import pytest_asyncio

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.context import ArtifactEditContextBuilder, ContextBuilder, ContextCompactor
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.contracts import ContractCheckData
from deepresearch_agent.harness.run_context import RunContext
from deepresearch_agent.memory import MemoryRejected, MemoryService
from deepresearch_agent.persistence import ArtifactStore, Database
from deepresearch_agent.persistence.repositories import (
    ArtifactRepository, AuditRepository, ContractRepository, MemoryRepository,
    MessageRepository, RunRepository, SessionRepository,
)
from deepresearch_agent.sessions import SessionSearchService


@pytest_asyncio.fixture
async def database(tmp_path):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'context-v2.db').as_posix()}")
    await db.create_schema()
    yield db
    await db.close()


def memory_service(database, **limits):
    return MemoryService(MemoryRepository(database), AuditRepository(database), **limits)


async def create_run(database, session_id: str, content: str, client_id: str):
    return await RunRepository(database).create_for_user_message(
        MessageCreate(session_id=session_id, role="user", content=content, client_message_id=client_id),
        RunCreate(session_id=session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )


def make_builder(database, service, *, max_tokens=4000, artifact_context_builder=None):
    sessions, messages = SessionRepository(database), MessageRepository(database)
    return ContextBuilder(
        messages=messages, sessions=sessions, memory_service=service,
        session_search=SessionSearchService(messages, sessions),
        compactor=ContextCompactor(sessions, messages, threshold_tokens=1000, protect_recent_messages=4),
        artifact_context_builder=artifact_context_builder,
        max_tokens=max_tokens, max_chars=16000, recent_turns=4,
    )


@pytest.mark.asyncio
async def test_curated_memory_has_two_targets_and_hard_capacity(database):
    service = memory_service(database, user_max_tokens=20, project_max_tokens=20, user_max_chars=80, project_max_chars=80)
    item = await service.create_candidate(target="user", content="用户偏好简洁回答", kind="preference", provenance_refs=["message:m1"], activate=True, created_by="user")
    assert item.status == "active"
    with pytest.raises(MemoryRejected):
        await service.create_candidate(target="session", content="临时内容", kind="note", provenance_refs=[], activate=True)
    with pytest.raises(MemoryRejected):
        await service.create_candidate(target="user", content="很长的偏好" * 30, kind="preference", provenance_refs=["message:m2"], activate=True)
    snapshot = await service.build_snapshot()
    assert snapshot["tokens"] <= 20
    assert snapshot["items"]["user"][0]["memory_id"] == item.memory_id


@pytest.mark.asyncio
async def test_memory_snapshot_is_frozen_and_refreshes_next_session(database):
    sessions = SessionRepository(database)
    service = memory_service(database)
    original = await service.create_candidate(target="project", content="项目使用 SQLite", kind="fact", provenance_refs=["message:m1"], activate=True)
    first_session = await sessions.create(SessionCreate(title="first"))
    trigger, run, _ = await create_run(database, first_session.session_id, "介绍项目", "first-1")
    first_context = await make_builder(database, service).build(RunContext(run_id=run.run_id, session_id=first_session.session_id, trigger_message_id=trigger.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger.content))
    await service.update(original.memory_id, content="项目使用 PostgreSQL")
    trigger2, run2, _ = await create_run(database, first_session.session_id, "继续介绍", "first-2")
    second_context = await make_builder(database, service).build(RunContext(run_id=run2.run_id, session_id=first_session.session_id, trigger_message_id=trigger2.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger2.content))
    assert "SQLite" in second_context.model_input and "PostgreSQL" not in second_context.model_input
    assert first_context.context_snapshot["stable_snapshot_id"] == second_context.context_snapshot["stable_snapshot_id"]
    new_session = await sessions.create(SessionCreate(title="new"))
    trigger3, run3, _ = await create_run(database, new_session.session_id, "介绍项目", "new-1")
    new_context = await make_builder(database, service).build(RunContext(run_id=run3.run_id, session_id=new_session.session_id, trigger_message_id=trigger3.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger3.content))
    assert "PostgreSQL" in new_context.model_input
    assert new_context.context_snapshot["stable_snapshot_id"] != first_context.context_snapshot["stable_snapshot_id"]


@pytest.mark.asyncio
async def test_session_search_is_cross_session_adaptive_and_on_demand(database):
    sessions, messages = SessionRepository(database), MessageRepository(database)
    old = await sessions.create(SessionCreate(title="SQLite 迁移"))
    for index, content in enumerate(("项目数据库采用 SQLite", "决定使用 WAL 和 checkpoint", "迁移已经完成")):
        await messages.append(MessageCreate(session_id=old.session_id, role="user" if index == 0 else "assistant", content=content, client_message_id="old" if index == 0 else None))
    current = await sessions.create(SessionCreate(title="current"))
    service = SessionSearchService(messages, sessions)
    assert not service.should_search("解释 SQLite 的 WAL")
    assert service.should_search("继续上次 SQLite 持久化的讨论")
    hits = await service.search("继续上次 SQLite 持久化的讨论", exclude_session_id=current.session_id)
    assert hits and hits[0].session_id == old.session_id
    assert hits[0].detail == "full" and hits[0].bookend_start and hits[0].bookend_end
    trigger, run, _ = await create_run(database, current.session_id, "普通独立问题", "current-1")
    context = await make_builder(database, memory_service(database)).build(RunContext(run_id=run.run_id, session_id=current.session_id, trigger_message_id=trigger.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger.content))
    assert context.context_snapshot["historical_recall_searched"] is False
    assert context.context_snapshot["historical_recall"] == []


@pytest.mark.asyncio
async def test_token_pressure_compaction_preserves_sources_and_reversal(database):
    sessions, messages = SessionRepository(database), MessageRepository(database)
    session = await sessions.create(SessionCreate(title="long"))
    contents = ["研究新能源汽车市场并生成报告", "已完成市场规模分析", "必须保留数据引用", "已完成竞争格局分析", "停止之前的国际市场任务，换个主题", "已停止国际市场部分", "现在只分析国内市场", "好的，将范围限定为国内市场"]
    for index, content in enumerate(contents):
        await messages.append(MessageCreate(session_id=session.session_id, role="user" if index % 2 == 0 else "assistant", content=content * 5, client_message_id=f"m{index}" if index % 2 == 0 else None))
    summary = await ContextCompactor(sessions, messages, threshold_tokens=20, protect_recent_messages=2).get_or_update(session.session_id)
    assert summary["goal"].startswith("研究新能源汽车")
    assert summary["covered_message_ids"] and summary["superseded"]
    assert json.loads((await sessions.get(session.session_id)).summary_json)["covered_message_ids"] == summary["covered_message_ids"]


@pytest.mark.asyncio
async def test_partial_report_edit_loads_target_and_preserve_hashes(database, tmp_path):
    sessions, runs = SessionRepository(database), RunRepository(database)
    session = await sessions.create(SessionCreate(title="report"))
    _, old_run, _ = await create_run(database, session.session_id, "生成新能源汽车报告", "report-1")
    contracts = ContractRepository(database)
    await contracts.upsert(ContractCheckData(check_id=f"check-{old_run.run_id}", run_id=old_run.run_id, kind="source_match", verifier="test", verifier_version="1", passed=True))
    report = "# 新能源汽车报告\n\n## 1. 市场规模\n\n规模内容。\n\n## 2. 竞争格局\n\n旧的竞争内容。\n\n## 3. 风险\n\n风险内容。"
    await runs.complete_verified(old_run.run_id, assistant_content=report, usage={})
    store = ArtifactStore(tmp_path / "artifacts")
    stored = store.write_text(f"{old_run.run_id}/report/final.md", report, mime_type="text/markdown; charset=utf-8")
    artifacts = ArtifactRepository(database)
    await artifacts.record(stored, run_id=old_run.run_id)
    _, new_run, _ = await create_run(database, session.session_id, "只修改竞争格局，不要修改其他部分", "report-2")
    edit = await ArtifactEditContextBuilder(runs, artifacts, store).build(session_id=session.session_id, current_run_id=new_run.run_id, query="只修改竞争格局，不要修改其他部分")
    assert edit is not None and edit["target_heading"] == "2. 竞争格局"
    assert "旧的竞争内容" in edit["target_content"]
    assert {item["heading"] for item in edit["preserve_sections"]} == {"新能源汽车报告", "1. 市场规模", "3. 风险"}
    assert all(len(item["sha256"]) == 64 for item in edit["preserve_sections"])
    merged = ArtifactEditContextBuilder.apply_replacement(
        report, edit, "## 2. 竞争格局\n\n新的竞争内容。",
    )
    assert "新的竞争内容" in merged and "旧的竞争内容" not in merged
    assert "规模内容" in merged and "风险内容" in merged


@pytest.mark.asyncio
async def test_context_pack_is_budgeted_and_traceable(database):
    sessions, messages = SessionRepository(database), MessageRepository(database)
    session = await sessions.create(SessionCreate(title="budget"))
    for index in range(12):
        await messages.append(MessageCreate(session_id=session.session_id, role="user" if index % 2 == 0 else "assistant", content=(f"第 {index} 轮上下文 " + "很长内容" * 40), client_message_id=f"b{index}" if index % 2 == 0 else None))
    trigger, run, _ = await create_run(database, session.session_id, "当前问题必须保留", "budget-current")
    context = await make_builder(database, memory_service(database), max_tokens=900).build(RunContext(run_id=run.run_id, session_id=session.session_id, trigger_message_id=trigger.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger.content))
    snapshot = context.context_snapshot
    assert snapshot["total_input_tokens"] <= 900
    assert "当前问题必须保留" in context.model_input
    assert snapshot["stable_snapshot_id"] and snapshot["retrieval_trace"]
    assert all({"source_type", "source_ids", "trust_level", "tokens"} <= set(item) for item in snapshot["retrieval_trace"])


@pytest.mark.asyncio
async def test_unresolved_reference_requests_clarification(database):
    session = await SessionRepository(database).create(SessionCreate(title="ambiguous"))
    trigger, run, _ = await create_run(database, session.session_id, "那一部分继续修改", "ambiguous-1")
    context = RunContext(run_id=run.run_id, session_id=session.session_id, trigger_message_id=trigger.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger.content)
    with pytest.raises(ValueError, match="needs_user_input"):
        await make_builder(database, memory_service(database)).build(context)
    assert "clarification_question" in context.config_snapshot
