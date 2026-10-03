"""Prefix cache 追踪链路测试：usage 提取、tracker 记账、Run 归属、ContextBuilder 前缀稳定排序。"""

from __future__ import annotations

import pytest
import pytest_asyncio
from langchain_core.messages import AIMessage

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.budgets import BudgetUsage
from deepresearch_agent.harness.run_context import RunContext
from deepresearch_agent.memory import (
    ContextBuilder,
    EpisodicMemory,
    MemoryRetriever,
    MemoryService,
    SessionSummarizer,
)
from deepresearch_agent.models.prefix_cache import (
    PrefixCacheTracker,
    extract_usage,
    get_current_run,
    set_current_run,
)
from deepresearch_agent.persistence import Database
from deepresearch_agent.persistence.repositories import (
    AuditRepository,
    MemoryRepository,
    MessageRepository,
    RunRepository,
    SessionRepository,
)


@pytest.fixture(autouse=True)
def _clean_run_contextvar():
    """测试间清理 contextvar，避免 Run 归属泄漏。"""
    yield
    set_current_run(None)


# ---------- usage 字段提取（兼容多网关命名） ----------

def _usage_metadata(*, input_tokens: int, output_tokens: int, cached: int | None = None) -> dict:
    details: dict = {}
    if cached is not None:
        details["cached"] = cached
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "input_token_details": details,
    }


def test_extract_usage_langchain_openai_shape() -> None:
    response = AIMessage(
        content="ok",
        usage_metadata=_usage_metadata(input_tokens=100, output_tokens=20, cached=80),
    )
    assert extract_usage(response) == {
        "requests": 1, "input_tokens": 100, "hit_tokens": 80, "miss_tokens": 20, "output_tokens": 20,
    }


def test_extract_usage_deepseek_shape() -> None:
    response = AIMessage(
        content="ok",
        response_metadata={
            "token_usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "prompt_cache_hit_tokens": 70,
            }
        },
    )
    assert extract_usage(response)["hit_tokens"] == 70
    assert extract_usage(response)["miss_tokens"] == 50


def test_extract_usage_openai_prompt_tokens_details() -> None:
    response = AIMessage(
        content="ok",
        response_metadata={
            "token_usage": {
                "prompt_tokens": 90,
                "completion_tokens": 10,
                "prompt_tokens_details": {"cached_tokens": 90},
            }
        },
    )
    assert extract_usage(response) == {
        "requests": 1, "input_tokens": 90, "hit_tokens": 90, "miss_tokens": 0, "output_tokens": 10,
    }


def test_extract_usage_ignores_request_without_input_tokens() -> None:
    response = AIMessage(content="ok")
    assert extract_usage(response) is None


def test_extract_usage_miss_only_gateway() -> None:
    response = AIMessage(
        content="ok",
        response_metadata={"token_usage": {"prompt_tokens": 60, "completion_tokens": 5, "prompt_cache_miss_tokens": 25}},
    )
    usage = extract_usage(response)
    assert usage is not None
    assert usage["hit_tokens"] == 35
    assert usage["miss_tokens"] == 25


def test_extract_usage_counts_request_without_cache_report_as_miss() -> None:
    """百炼等网关不报告任何缓存字段（prompt_cache_hit/miss_tokens 均为 null）时，
    无法折算命中率，应忽略该请求而不是把全部 token 误算为命中。"""
    response = AIMessage(
        content="ok",
        response_metadata={
            "token_usage": {
                "prompt_tokens": 80,
                "completion_tokens": 10,
                "prompt_cache_hit_tokens": None,
                "prompt_cache_miss_tokens": None,
            }
        },
    )
    assert extract_usage(response) == {
        "requests": 1,
        "input_tokens": 80,
        "hit_tokens": 0,
        "miss_tokens": 80,
        "output_tokens": 10,
    }


def test_extract_usage_explicit_zero_miss_means_full_hit() -> None:
    """prompt_cache_miss_tokens 显式为 0 是网关的明确报告（全部命中），不是缺失。"""
    response = AIMessage(
        content="ok",
        response_metadata={"token_usage": {"prompt_tokens": 50, "completion_tokens": 5, "prompt_cache_miss_tokens": 0}},
    )
    usage = extract_usage(response)
    assert usage is not None
    assert usage["hit_tokens"] == 50
    assert usage["miss_tokens"] == 0


def test_tracker_record_tolerates_none_values() -> None:
    """防御性兜底：即使上游 dict 出现 None 键值也不抛 int += None。"""
    tracker = PrefixCacheTracker()
    tracker.record(model="m", usage={"requests": None, "input_tokens": 100, "hit_tokens": None, "miss_tokens": None, "output_tokens": None})
    snapshot = tracker.global_snapshot()
    assert snapshot["totals"]["requests"] == 1
    assert snapshot["totals"]["input_tokens"] == 100
    assert snapshot["totals"]["hit_tokens"] == 0
    assert snapshot["totals"]["miss_tokens"] == 0
    assert snapshot["totals"]["output_tokens"] == 0


# ---------- tracker 记账与 Run 归属 ----------

def test_tracker_records_global_and_per_run_via_contextvar() -> None:
    tracker = PrefixCacheTracker()
    set_current_run("run-1")
    tracker.record(model="qwen-plus", usage={"requests": 1, "input_tokens": 100, "hit_tokens": 80, "miss_tokens": 20, "output_tokens": 10})
    tracker.record(model="qwen-plus", usage={"requests": 1, "input_tokens": 200, "hit_tokens": 50, "miss_tokens": 150, "output_tokens": 15})
    set_current_run("run-2")
    tracker.record(model="qwen-plus", usage={"requests": 1, "input_tokens": 50, "hit_tokens": 40, "miss_tokens": 10, "output_tokens": 5})

    run1 = tracker.run_snapshot("run-1")
    assert run1 is not None
    assert run1["totals"]["requests"] == 2
    assert run1["totals"]["hit_tokens"] == 130
    assert run1["totals"]["miss_tokens"] == 170
    assert run1["hit_rate"] == pytest.approx(130 / 300)

    run2 = tracker.run_snapshot("run-2")
    assert run2 is not None and run2["totals"]["requests"] == 1
    assert tracker.run_snapshot("run-missing") is None

    global_snapshot = tracker.global_snapshot()
    assert global_snapshot["totals"]["requests"] == 3
    assert global_snapshot["totals"]["hit_tokens"] == 170
    assert global_snapshot["totals"]["miss_tokens"] == 180
    assert global_snapshot["hit_rate"] == pytest.approx(170 / 350)
    assert global_snapshot["per_model"]["qwen-plus"]["hit_tokens"] == 170


def test_tracker_ignores_request_without_current_run() -> None:
    tracker = PrefixCacheTracker()
    set_current_run(None)
    tracker.record(model="m", usage={"requests": 1, "input_tokens": 10, "hit_tokens": 0, "miss_tokens": 10, "output_tokens": 0})
    assert tracker.global_snapshot()["totals"]["requests"] == 1
    assert tracker.run_snapshot("any") is None


def test_tracker_reset() -> None:
    tracker = PrefixCacheTracker()
    set_current_run("run")
    tracker.record(model="m", usage={"requests": 1, "input_tokens": 10, "hit_tokens": 0, "miss_tokens": 10, "output_tokens": 0})
    tracker.reset()
    assert tracker.global_snapshot()["totals"]["requests"] == 0
    assert tracker.run_snapshot("run") is None


def test_contextvar_helpers_roundtrip() -> None:
    assert get_current_run() is None
    set_current_run("run-x")
    assert get_current_run() == "run-x"


# ---------- BudgetUsage 字段 ----------

def test_budget_usage_has_prefix_cache_fields() -> None:
    usage = BudgetUsage()
    dump = usage.model_dump()
    assert dump["prefix_cache_requests"] == 0
    assert dump["prefix_cache_hit_tokens"] == 0
    assert dump["prefix_cache_miss_tokens"] == 0


# ---------- ContextBuilder 前缀稳定排序 ----------

@pytest_asyncio.fixture
async def database(tmp_path):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'prefix_cache.db').as_posix()}")
    await db.create_schema()
    yield db
    await db.close()


@pytest.mark.asyncio
async def test_context_builder_puts_stable_content_first(database) -> None:
    sessions, messages, runs = SessionRepository(database), MessageRepository(database), RunRepository(database)
    session = await sessions.create(SessionCreate(title="prefix"))
    # 多轮历史：让会话摘要与历史背景都出现，模拟"稳定增长"前缀形态
    for index in range(24):
        await messages.append(MessageCreate(
            session_id=session.session_id,
            role="user" if index % 2 == 0 else "assistant",
            content=f"第 {index} 轮：讨论 SQLite 会话持久化",
            client_message_id=f"h{index}",
        ))
    trigger, run, _ = await runs.create_for_user_message(
        MessageCreate(session_id=session.session_id, role="user", content="那恢复机制呢？", client_message_id="current"),
        RunCreate(session_id=session.session_id, trigger_message_id="atomic", source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH),
    )
    # 一条已激活的语义记忆，应出现在变量区（查询之后）
    repository = MemoryRepository(database)
    service = MemoryService(repository, AuditRepository(database))
    item = await service.create_candidate(content="会话恢复使用 CheckpointManager", scope="project", kind="fact", provenance_refs=["message:m1"], confidence=0.9, session_id=session.session_id)
    await service.update(item.memory_id, status="active")

    builder = ContextBuilder(messages, EpisodicMemory(messages, runs), MemoryRetriever(repository), SessionSummarizer(sessions, messages), max_chars=6000)
    context = await builder.build(RunContext(
        run_id=run.run_id, session_id=session.session_id, trigger_message_id=trigger.message_id,
        source_mode=SourceMode.GRAPHRAG, workflow_mode=WorkflowMode.DEEP_RESEARCH,
        status="context_building", original_query=trigger.content,
    ))

    text = context.model_input
    # 稳定区在前：摘要 -> 历史背景
    summary_pos = text.find("# 会话摘要")
    history_pos = text.find("# 会话历史背景")
    assert summary_pos >= 0 and history_pos > summary_pos
    # 变量区在后：消解后的查询、记忆都排在历史背景之后
    query_pos = text.find(context.resolved_query)
    memory_pos = text.find("经用户确认的相关 Memory")
    assert query_pos > history_pos
    assert memory_pos > query_pos
    assert "CheckpointManager" in text[memory_pos:]
