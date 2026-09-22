import json

import pytest
import pytest_asyncio

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.checkpoints import CheckpointManager
from deepresearch_agent.harness.contracts import ContractCheckData
from deepresearch_agent.harness.run_context import RunContext
from deepresearch_agent.memory import (
    ContextBuilder, EpisodicMemory, MemoryExtractor, MemoryPolicy, MemoryRejected,
    MemoryRetriever, MemoryService, QueryResolver, SessionSummarizer,
)
from deepresearch_agent.persistence import Database
from deepresearch_agent.persistence.repositories import (
    AuditRepository, CheckpointRepository, ContractRepository, MemoryRepository,
    MessageRepository, RunRepository, SessionRepository,
)


@pytest_asyncio.fixture
async def database(tmp_path):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'memory.db').as_posix()}")
    await db.create_schema()
    yield db
    await db.close()


async def new_session(database, title="memory"):
    return await SessionRepository(database).create(SessionCreate(title=title))


class FakeMemoryLlm:
    def __init__(self, payload):
        self.payload = payload
        self.received = None

    async def ainvoke(self, messages):
        self.received = messages
        content = self.payload if isinstance(self.payload, str) else json.dumps(self.payload, ensure_ascii=False)
        return type("MemoryLlmResponse", (), {"content": content})()


@pytest.mark.asyncio
async def test_query_resolver_uses_only_same_session_history(database):
    session = await new_session(database)
    messages = MessageRepository(database)
    first, _ = await messages.append(MessageCreate(session_id=session.session_id, role="user", content="比较国家奖学金规则", client_message_id="a"))
    answer, _ = await messages.append(MessageCreate(session_id=session.session_id, role="assistant", content="国家奖学金有明确申请条件"))
    resolved = QueryResolver().resolve("那上海市奖学金呢？", [first, answer])
    assert "上海市奖学金" in resolved.resolved_query
    assert resolved.used_message_ids == [first.message_id, answer.message_id]


@pytest.mark.asyncio
async def test_semantic_memory_cross_session_recall_and_irrelevance_filter(database):
    repository = MemoryRepository(database)
    service = MemoryService(repository, AuditRepository(database))
    a, b = await new_session(database, "A"), await new_session(database, "B")
    item = await service.create_candidate(content="项目数据库采用 SQLite 持久化", scope="project", kind="fact", provenance_refs=["message:m1"], confidence=0.9, session_id=a.session_id)
    await service.update(item.memory_id, status="active")
    retriever = MemoryRetriever(repository, max_chars=200)
    assert [hit.memory_id for hit in await retriever.retrieve("SQLite 数据库如何持久化", session_id=b.session_id)] == [item.memory_id]
    assert await retriever.retrieve("今天上海天气", session_id=b.session_id) == []


@pytest.mark.asyncio
async def test_conflict_creates_candidate_with_supersedes(database):
    repository = MemoryRepository(database)
    service = MemoryService(repository, AuditRepository(database))
    session = await new_session(database)
    old = await service.create_candidate(content="项目必须使用 SQLite 持久化会话", scope="project", kind="fact", provenance_refs=["run:old"], confidence=0.8, session_id=session.session_id)
    await service.update(old.memory_id, status="active")
    new = await service.create_candidate(content="项目必须使用 SQLite 持久化所有会话", scope="project", kind="fact", provenance_refs=["run:new"], confidence=0.9, session_id=session.session_id)
    assert new.status == "candidate"
    assert new.supersedes == old.memory_id
    assert (await repository.get(old.memory_id)).status == "active"


@pytest.mark.asyncio
async def test_memory_budget_and_sensitive_content_policy(database):
    repository = MemoryRepository(database)
    service = MemoryService(repository, AuditRepository(database), policy=MemoryPolicy())
    session = await new_session(database)
    with pytest.raises(MemoryRejected):
        await service.create_candidate(content="api_key=sk-secret123456", scope="project", kind="fact", provenance_refs=["message:x"], confidence=1, session_id=session.session_id)
    for index in range(3):
        item = await service.create_candidate(content=f"SQLite 持久化规则 {index} " + "证据" * 50, scope="project", kind="fact", provenance_refs=[f"message:{index}"], confidence=0.9, session_id=session.session_id)
        await service.update(item.memory_id, status="active")
    hits = await MemoryRetriever(repository, max_chars=200).retrieve("SQLite 持久化规则", session_id=session.session_id)
    assert hits and sum(len(item.content) for item in hits) <= 200


@pytest.mark.asyncio
async def test_full_ai_reply_is_rejected_and_legacy_reply_cannot_be_activated(database):
    repository = MemoryRepository(database)
    service = MemoryService(repository, AuditRepository(database), policy=MemoryPolicy())
    session = await new_session(database)
    full_reply = "# 研究报告\n\n" + "这是完整的 AI 报告正文。" * 80
    with pytest.raises(MemoryRejected, match="Memory|报告"):
        await service.create_candidate(
            content=full_reply, target="project", kind="note",
            provenance_refs=["run:legacy"], session_id=session.session_id,
        )
    legacy = await repository.create_candidate(
        content=full_reply, scope="project", kind="note",
        provenance_refs=["run:legacy"], confidence=0.8,
        session_id=None, created_by="agent",
    )
    with pytest.raises(MemoryRejected, match="Memory|报告"):
        await service.update(legacy.memory_id, status="active")


@pytest.mark.asyncio
async def test_episodic_fts_and_structured_summary_preserve_source_ids(database):
    session = await new_session(database)
    messages = MessageRepository(database)
    for index in range(12):
        await messages.append(MessageCreate(session_id=session.session_id, role="user" if index % 2 == 0 else "assistant", content=f"奖学金规则第{index}轮", client_message_id=f"turn-{index}" if index % 2 == 0 else None))
    hits = await EpisodicMemory(messages, RunRepository(database)).search("奖学金", session_id=session.session_id)
    assert hits and all(hit.message_id for hit in hits)
    summary = await SessionSummarizer(SessionRepository(database), messages, threshold_messages=10).get_or_update(session.session_id)
    assert summary["message_ids"]
    stored = await SessionRepository(database).get(session.session_id)
    assert json.loads(stored.summary_json)["message_ids"] == summary["message_ids"]


@pytest.mark.asyncio
async def test_context_builder_is_bounded_and_checkpointed_as_working_memory(database):
    sessions, messages, runs = SessionRepository(database), MessageRepository(database), RunRepository(database)
    session = await sessions.create(SessionCreate(title="context"))
    await messages.append(MessageCreate(session_id=session.session_id, role="user", content="讨论 SQLite 会话", client_message_id="history"))
    trigger, run, _ = await runs.create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="那恢复呢？", client_message_id="current"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )
    memory_repository = MemoryRepository(database)
    builder = ContextBuilder(messages, EpisodicMemory(messages, runs), MemoryRetriever(memory_repository), SessionSummarizer(sessions, messages), max_chars=2200)
    context = await builder.build(RunContext(run_id=run.run_id, session_id=session.session_id, trigger_message_id=trigger.message_id, source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH, status="context_building", original_query=trigger.content))
    assert context.used_message_ids and len(json.dumps(context.context_snapshot, ensure_ascii=False)) <= 2200
    manager = CheckpointManager(CheckpointRepository(database))
    await manager.save(context, "context_building")
    restored = await manager.restore(run.run_id)
    assert restored.context_snapshot == context.context_snapshot


@pytest.mark.asyncio
async def test_extractor_requires_verified_completed_run(database):
    sessions, messages, runs = SessionRepository(database), MessageRepository(database), RunRepository(database)
    session = await sessions.create(SessionCreate(title="extract"))
    trigger, run, _ = await runs.create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="请记住我偏好简短报告", client_message_id="extract"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )
    repository = MemoryRepository(database)
    llm = FakeMemoryLlm({"candidates": [{
        "target": "user", "kind": "preference", "content": "用户偏好简短报告",
        "confidence": 0.93, "evidence_quote": "我偏好简短报告", "rationale": "明确的长期偏好",
    }]})
    extractor = MemoryExtractor(
        MemoryService(repository, AuditRepository(database)), runs, messages,
        ContractRepository(database), llm=llm,
    )
    assert await extractor.extract_from_completed_run(run.run_id) == []
    contracts = ContractRepository(database)
    await contracts.upsert(ContractCheckData(check_id=f"check-{run.run_id}", run_id=run.run_id, kind="source_match", verifier="test", verifier_version="1", passed=True))
    await runs.complete_verified(run.run_id, assistant_content="# 报告\n\n这是通过证据验证后形成的结论，内容足够用于创建审阅候选。", usage={})
    created = await extractor.extract_from_completed_run(run.run_id)
    assert {item.kind for item in created} == {"preference"}
    assert all(item.status == "candidate" for item in created)
    assert all(item.created_by == "llm_review" for item in created)
    assert "请记住我偏好简短报告" in llm.received[1].content
    assert "这是通过证据验证后形成的结论" not in llm.received[1].content


@pytest.mark.asyncio
async def test_llm_extractor_accepts_implicit_feedback_but_requires_grounded_quote(database):
    sessions, messages, runs = SessionRepository(database), MessageRepository(database), RunRepository(database)
    session = await sessions.create(SessionCreate(title="implicit preference"))
    trigger, run, _ = await runs.create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="这个表格太复杂了，我更容易阅读简洁的要点。", client_message_id="implicit"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )
    contracts = ContractRepository(database)
    await contracts.upsert(ContractCheckData(check_id=f"check-{run.run_id}", run_id=run.run_id, kind="source_match", verifier="test", verifier_version="1", passed=True))
    await runs.complete_verified(run.run_id, assistant_content="# 回答\n\n已经改为要点。", usage={})
    llm = FakeMemoryLlm({"candidates": [
        {"target": "user", "kind": "preference", "content": "用户偏好简洁要点，避免复杂表格", "confidence": 0.91, "evidence_quote": "我更容易阅读简洁的要点", "rationale": "用户反馈"},
        {"target": "user", "kind": "preference", "content": "用户偏好英文", "confidence": 0.99, "evidence_quote": "我偏好英文", "rationale": "无原文证据"},
        {"target": "project", "kind": "decision", "content": "项目固定使用表格", "confidence": 0.60, "evidence_quote": "这个表格太复杂了", "rationale": "置信度不足"},
    ]})
    extractor = MemoryExtractor(
        MemoryService(MemoryRepository(database), AuditRepository(database)), runs, messages,
        contracts, llm=llm, min_confidence=0.75,
    )
    created = await extractor.extract_from_completed_run(run.run_id)
    assert len(created) == 1
    assert created[0].content == "用户偏好简洁要点，避免复杂表格"
    assert json.loads(created[0].provenance_json) == [f"run:{run.run_id}", f"message:{trigger.message_id}"]


def test_llm_extractor_rejects_malformed_structured_output():
    with pytest.raises(ValueError, match="JSON"):
        MemoryExtractor._parse_json("I think the user likes concise reports")
    with pytest.raises(ValueError, match="candidates"):
        MemoryExtractor._parse_json('{"memory": []}')


@pytest.mark.asyncio
async def test_memory_delete_does_not_delete_messages_or_unrelated_cache(database):
    session = await new_session(database)
    messages = MessageRepository(database)
    message, _ = await messages.append(MessageCreate(session_id=session.session_id, role="user", content="历史消息仍保留", client_message_id="keep"))
    service = MemoryService(MemoryRepository(database), AuditRepository(database))
    item = await service.create_candidate(content="历史消息仍保留", target="project", kind="decision", provenance_refs=[f"message:{message.message_id}"], confidence=0.8)
    assert await service.delete(item.memory_id)
    assert (await messages.get(message.message_id)).content == "历史消息仍保留"

