import hashlib

import pytest
import pytest_asyncio
from pydantic import ValidationError

from backend.app.schemas import MessageCreate, RunCreate, RunEventCreate, SessionCreate
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.persistence import ArtifactStore, Database
from deepresearch_agent.persistence.trajectory_exporter import TrajectoryExporter
from deepresearch_agent.persistence.repositories import CheckpointRepository, EventRepository, MessageRepository, RunRepository, SessionRepository


@pytest_asyncio.fixture
async def database(tmp_path):
    db_file = (tmp_path / "app.db").as_posix()
    db = Database(f"sqlite+aiosqlite:///{db_file}")
    await db.create_schema()
    yield db
    await db.close()


@pytest.mark.asyncio
async def test_session_message_run_survive_reopen_and_are_idempotent(database, tmp_path):
    sessions = SessionRepository(database)
    runs = RunRepository(database)
    created_session = await sessions.create(SessionCreate(title="持久会话"))
    message = MessageCreate(session_id=created_session.session_id, role="user", content="测试持久化", client_message_id="client-1")
    run = RunCreate(session_id=created_session.session_id, trigger_message_id="assigned-atomically", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.PLAN_EXECUTE_REPORT)

    first_message, first_run, created = await runs.create_for_user_message(message, run)
    repeated_message, repeated_run, repeated = await runs.create_for_user_message(message, run)

    assert created is True
    assert repeated is False
    assert repeated_message.message_id == first_message.message_id
    assert repeated_run.run_id == first_run.run_id
    events = await EventRepository(database).list_after(first_run.run_id)
    assert [event.event_type for event in events] == ["run.queued"]
    assert await runs.acquire_lease(first_run.run_id, "worker-1", ttl_seconds=30)
    assert not await runs.acquire_lease(first_run.run_id, "worker-2", ttl_seconds=30)
    assert await runs.renew_lease(first_run.run_id, "worker-1", ttl_seconds=60)
    assert not await runs.renew_lease(first_run.run_id, "worker-2", ttl_seconds=60)
    assert await runs.release_lease(first_run.run_id, "worker-1")

    url = database.url
    await database.close()
    reopened = Database(url)
    assert (await SessionRepository(reopened).get(created_session.session_id)).title == "持久会话"
    assert (await RunRepository(reopened).get(first_run.run_id)).source_mode == "graphrag"
    await reopened.close()


@pytest.mark.asyncio
async def test_checkpoint_versions_hash_and_foreign_keys(database):
    session = await SessionRepository(database).create(SessionCreate(title="checkpoint"))
    message, run, _ = await RunRepository(database).create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="checkpoint", client_message_id="checkpoint-1"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )
    checkpoints = CheckpointRepository(database)
    first = await checkpoints.save(run.run_id, "context", {"value": 1})
    second = await checkpoints.save(run.run_id, "plan", {"value": 2})
    assert (first.version, second.version) == (1, 2)
    assert checkpoints.verify(second)
    assert await database.foreign_key_violations() == []


@pytest.mark.asyncio
async def test_fts_finds_message_and_session(database):
    session = await SessionRepository(database).create(SessionCreate(title="奖学金研究"))
    await MessageRepository(database).append(MessageCreate(session_id=session.session_id, role="user", content="上海市奖学金是否互斥", client_message_id="fts-1"))
    assert [item.session_id for item in await SessionRepository(database).search("奖学金")] == [session.session_id]
    assert [item.session_id for item in await MessageRepository(database).search("上海市")] == [session.session_id]


def test_source_mode_validation_and_database_constraint():
    with pytest.raises(ValidationError):
        RunCreate(session_id="ses_x", trigger_message_id="msg_x", source_mode="other", workflow_mode=WorkflowMode.DEEP_RESEARCH)


def test_artifact_store_confines_paths_and_verifies_hash(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    artifact = store.write_text("run_1/report/final.md", "报告")
    assert store.verify(artifact.relative_path, artifact.sha256)
    assert artifact.sha256 == hashlib.sha256("报告".encode("utf-8")).hexdigest()
    with pytest.raises(Exception):
        store.write_text("../escape.txt", "no")


def test_trajectory_export_redacts_secret_keys_and_values(tmp_path):
    exporter = TrajectoryExporter(ArtifactStore(tmp_path / "artifacts"))
    artifact = exporter.export(session_id="ses_1", payload={"api_key": "secret", "message": "Bearer abcdefghijklmnop", "safe": "ok"})
    exported = (tmp_path / "artifacts" / artifact.relative_path).read_text(encoding="utf-8")
    assert "secret" not in exported
    assert "abcdefghijklmnop" not in exported
    assert exported.count("[REDACTED]") == 2
