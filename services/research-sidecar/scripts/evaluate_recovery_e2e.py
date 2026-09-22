"""Hard-crash end-to-end evaluation for durable Harness recovery.

The evaluator runs each case in two independent spawned processes:

1. A Runtime process persists a selected stage checkpoint and then terminates via
   ``os._exit``.  This bypasses normal exception handling and lease cleanup.
2. A fresh RunService process performs the production startup-recovery scan and
   resumes the same Run from SQLite.

The workflow is deterministic and offline so the benchmark measures Harness
recovery rather than external LLM/search availability.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import multiprocessing
import os
from pathlib import Path
import sys
import time
from typing import Any

from sqlalchemy import func, select


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.agents.multi_agent.core.execution_record import (
    ExecutionMetadata,
    ExecutionRecord,
    ToolCall,
)
from deepresearch_agent.agents.multi_agent.core.retrieval_result import (
    RetrievalMetadata,
    RetrievalResult,
)
from deepresearch_agent.evaluation import EvaluationService
from deepresearch_agent.harness import SourceMode, WorkflowMode
from deepresearch_agent.harness.budgets import BudgetLimits
from deepresearch_agent.harness.runtime import HarnessRuntime
from deepresearch_agent.persistence import ArtifactStore, Database
from deepresearch_agent.persistence.models import MessageModel, RunEventModel, ToolCallModel
from deepresearch_agent.persistence.repositories import (
    ArtifactRepository,
    CheckpointRepository,
    ContractRepository,
    EventRepository,
    EvidenceRepository,
    MessageRepository,
    PlanTaskToolRepository,
    RunRepository,
    SessionRepository,
)


CRASH_EXIT_CODE = 86
TERMINAL_STAGES = ("planning", "executing", "reporting", "verifying")


class DeterministicRecoveryDriver:
    """Offline workflow with one observable external side effect."""

    def __init__(self, context, events=None):
        self.context = context
        restored = context.workflow_state
        self.planned = bool(restored.get("planned"))
        self.executed = bool(restored.get("executed"))
        self._report = restored.get("report")
        self.results = [
            RetrievalResult(
                result_id=f"raw-recovery-{index}",
                granularity="Chunk",
                evidence=f"Durable recovery evidence {index}",
                metadata=RetrievalMetadata(
                    source_id=f"recovery-doc-{index}",
                    source_type="chunk",
                    content_hash=character * 64,
                ),
                source="local_search",
                source_mode="graphrag",
                score=0.95,
            )
            for index, character in ((1, "a"), (2, "b"))
        ]
        for result, result_id in zip(self.results, restored.get("result_ids", [])):
            result.result_id = result_id

    async def plan(self, failures=None):
        self.planned = True

    async def execute(self):
        if self.executed:
            return
        marker = Path(self.context.config_snapshot["side_effect_file"])
        marker.parent.mkdir(parents=True, exist_ok=True)
        with marker.open("a", encoding="utf-8") as stream:
            stream.write(f"{self.context.run_id}\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.executed = True

    async def report(self):
        self._report = (
            "# 故障恢复评测报告\n\n"
            f"恢复后的结论由证据 [{self.results[0].result_id}] "
            f"和 [{self.results[1].result_id}] 支持。\n\n"
            "## 方法\n\n使用持久化 Checkpoint 与 Evidence Ledger。"
        )
        return self._report

    async def repair_report(self, failures):
        return False

    def snapshot(self):
        return {
            "planned": self.planned,
            "executed": self.executed,
            "result_ids": [item.result_id for item in self.results],
            "report": self._report,
        }

    def execution_records(self):
        if not self.executed:
            return []
        call = ToolCall(
            tool_name="local_search",
            tool_call_id=f"call-{self.context.run_id}",
            source_mode="graphrag",
            args={"query": "durable recovery"},
            result={"ok": True},
        )
        return [
            ExecutionRecord(
                task_id=f"task-{self.context.run_id}",
                session_id=self.context.session_id,
                worker_type="recovery-eval",
                tool_calls=[call],
                evidence=self.results,
                metadata=ExecutionMetadata(
                    worker_type="recovery-eval",
                    tool_calls_count=1,
                    evidence_count=2,
                ),
            )
        ]

    def evidence_results(self):
        if not self.executed:
            return []
        return [
            (
                f"task-{self.context.run_id}",
                f"call-{self.context.run_id}",
                "local_search",
                item,
            )
            for item in self.results
        ]

    def report_consistency(self):
        return True

    def plan_record(self):
        task = {
            "task_id": f"task-{self.context.run_id}",
            "task_type": "deep_research",
            "source_mode": "graphrag",
            "status": "pending",
            "description": "evaluate durable recovery",
        }
        return (
            {
                "plan_id": f"plan-{self.context.run_id}",
                "status": "executing",
                "tasks": [task],
            },
            [task],
        )


def _runtime(database: Database, artifact_root: Path) -> HarnessRuntime:
    return HarnessRuntime(
        run_repository=RunRepository(database),
        message_repository=MessageRepository(database),
        event_repository=EventRepository(database),
        checkpoint_repository=CheckpointRepository(database),
        evidence_repository=EvidenceRepository(database),
        contract_repository=ContractRepository(database),
        trajectory_repository=PlanTaskToolRepository(database),
        workflow_factory=DeterministicRecoveryDriver,
        artifact_store=ArtifactStore(artifact_root),
        artifact_repository=ArtifactRepository(database),
        lease_seconds=1,
    )


async def _crash_async(database_url: str, artifact_root: str, run_id: str, stage: str) -> None:
    database = Database(database_url)
    runtime = _runtime(database, Path(artifact_root))
    original_save = runtime.checkpoints.save

    async def crash_after_save(context, saved_stage: str):
        checkpoint = await original_save(context, saved_stage)
        if saved_stage == stage:
            os._exit(CRASH_EXIT_CODE)
        return checkpoint

    runtime.checkpoints.save = crash_after_save
    await runtime.execute_run(run_id)
    await database.close()


def _crash_worker(database_url: str, artifact_root: str, run_id: str, stage: str) -> None:
    asyncio.run(_crash_async(database_url, artifact_root, run_id, stage))


async def _resume_async(database_url: str, artifact_root: str, skills_root: str) -> None:
    # Keep this production-service import out of crash-worker startup.  On
    # Windows spawn, importing RunService also loads the full agent/model stack.
    from backend.app.services.run_service import RunService

    database = Database(database_url)
    service = RunService(
        database,
        workflow_factory=DeterministicRecoveryDriver,
        artifact_root=Path(artifact_root),
        skills_root=Path(skills_root),
    )
    try:
        run_ids = await service.startup_recovery(auto_resume=True)
        tasks = [service._tasks[run_id] for run_id in run_ids if run_id in service._tasks]
        if tasks:
            await asyncio.gather(*tasks)
    finally:
        await service.shutdown()
        await database.close()


def _resume_worker(database_url: str, artifact_root: str, skills_root: str) -> None:
    asyncio.run(_resume_async(database_url, artifact_root, skills_root))


async def _create_run(database_url: str, stage: str, repetition: int, marker: Path) -> str:
    database = Database(database_url)
    try:
        await database.create_schema()
        session = await SessionRepository(database).create(
            SessionCreate(title=f"recovery-{stage}-{repetition}")
        )
        _, run, _ = await RunRepository(database).create_for_user_message(
            MessageCreate(
                session_id=session.session_id,
                role="user",
                content=f"Evaluate recovery at {stage}",
                client_message_id=f"recovery-{stage}-{repetition}",
            ),
            RunCreate(
                session_id=session.session_id,
                trigger_message_id="atomic",
                source_mode=SourceMode.GRAPHRAG,
                workflow_mode=WorkflowMode.DEEP_RESEARCH,
                config_snapshot={
                    "min_evidence": 1,
                    "side_effect_file": str(marker.resolve()),
                },
                budget=BudgetLimits().model_dump(),
            ),
        )
        return run.run_id
    finally:
        await database.close()


async def _inspect_run(database_url: str, run_id: str, marker: Path) -> dict[str, Any]:
    database = Database(database_url)
    try:
        evaluated = await EvaluationService(database).evaluate_run(run_id)
        async with database.sessions() as session:
            event_rows = list(
                (
                    await session.execute(
                        select(RunEventModel)
                        .where(RunEventModel.run_id == run_id)
                        .order_by(RunEventModel.event_id)
                    )
                ).scalars()
            )
            assistant_count = int(
                (
                    await session.execute(
                        select(func.count())
                        .select_from(MessageModel)
                        .where(MessageModel.run_id == run_id, MessageModel.role == "assistant")
                    )
                ).scalar_one()
            )
            tool_count = int(
                (
                    await session.execute(
                        select(func.count())
                        .select_from(ToolCallModel)
                        .where(ToolCallModel.run_id == run_id)
                    )
                ).scalar_one()
            )
        event_types = [row.event_type for row in event_rows]
        side_effect_count = 0
        if marker.exists():
            side_effect_count = len(
                [line for line in marker.read_text(encoding="utf-8").splitlines() if line.strip()]
            )
        return {
            "run_id": run_id,
            "status": evaluated.status,
            "verified_completion": evaluated.verified_completion,
            "recovery_attempted": evaluated.recovery_attempted,
            "recovery_succeeded": evaluated.recovery_succeeded,
            "required_contract_pass_rate": evaluated.required_contract_pass_rate,
            "required_contract_total": evaluated.required_contract_total,
            "checkpoint_count": evaluated.checkpoint_count,
            "checkpoint_integrity_rate": evaluated.checkpoint_integrity_rate,
            "tool_call_count": tool_count,
            "duplicate_side_effect_rate": evaluated.duplicate_side_effect_rate,
            "external_side_effect_count": side_effect_count,
            "assistant_message_count": assistant_count,
            "run_interrupted_events": event_types.count("run.interrupted"),
            "run_resumed_events": event_types.count("run.resumed"),
            "run_completed_events": event_types.count("run.completed"),
            "event_ids_strictly_increasing": all(
                left.event_id < right.event_id for left, right in zip(event_rows, event_rows[1:])
            ),
        }
    finally:
        await database.close()


def _wilson_interval(successes: int, attempts: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if attempts == 0:
        return (0.0, 0.0)
    proportion = successes / attempts
    denominator = 1 + z * z / attempts
    centre = (proportion + z * z / (2 * attempts)) / denominator
    margin = z * math.sqrt(
        proportion * (1 - proportion) / attempts + z * z / (4 * attempts * attempts)
    ) / denominator
    return max(0.0, centre - margin), min(1.0, centre + margin)


def _case_passed(case: dict[str, Any]) -> bool:
    return all(
        (
            case["crash_exit_code"] == CRASH_EXIT_CODE,
            case["resume_exit_code"] == 0,
            case["verified_completion"] is True,
            case["recovery_attempted"] is True,
            case["recovery_succeeded"] is True,
            case["required_contract_pass_rate"] == 1.0,
            case["checkpoint_integrity_rate"] == 1.0,
            case["duplicate_side_effect_rate"] == 0.0,
            case["external_side_effect_count"] == 1,
            case["assistant_message_count"] == 1,
            case["run_interrupted_events"] == 1,
            case["run_resumed_events"] == 1,
            case["run_completed_events"] == 1,
            case["event_ids_strictly_increasing"] is True,
        )
    )


def _render_markdown(payload: dict[str, Any]) -> str:
    summary = payload["summary"]
    lines = [
        "# Harness 硬崩溃端到端恢复评测",
        "",
        f"> 执行时间：{payload['executed_at']}",
        "> 路径：独立进程 Harness → SQLite Checkpoint/Lease → `os._exit` 硬崩溃 → 新进程 RunService startup recovery → Contract 验证。",
        "> 工作流使用离线确定性 Driver；本评测衡量 Harness 恢复，不衡量外部 LLM 或检索服务可用性。",
        "",
        "## 结果",
        "",
        "| 指标 | 结果 |",
        "|---|---:|",
        f"| 恢复成功率 | **{summary['recovery_success_rate']:.2%} ({summary['successes']}/{summary['attempts']})** |",
        f"| 95% Wilson CI | {summary['recovery_success_ci_95'][0]:.2%}～{summary['recovery_success_ci_95'][1]:.2%} |",
        f"| Checkpoint 完整率 | {summary['checkpoint_integrity_rate']:.2%} |",
        f"| 重复副作用率 | {summary['duplicate_side_effect_rate']:.2%} |",
        f"| Assistant 消息恰好一次 | {summary['exactly_once_assistant_rate']:.2%} |",
        f"| 事件序列完整率 | {summary['event_sequence_integrity_rate']:.2%} |",
        f"| P50 / P95 恢复耗时 | {summary['recovery_latency_p50_ms']:.1f} / {summary['recovery_latency_p95_ms']:.1f} ms |",
        "",
        "这里的恢复耗时从崩溃进程启动计到恢复进程结束，包含 Windows 两次新进程冷启动与租约等待，不是纯 Checkpoint 读取耗时。",
        "",
        "## 分阶段结果",
        "",
        "| 故障点 | 成功 / 尝试 | 成功率 |",
        "|---|---:|---:|",
    ]
    for stage, result in payload["by_stage"].items():
        lines.append(
            f"| `{stage}` checkpoint 后硬退出 | {result['successes']} / {result['attempts']} | {result['success_rate']:.2%} |"
        )
    lines.extend(
        [
            "",
            "## 成功判定",
            "",
            "单个案例必须同时满足：崩溃进程退出码 86；新进程成功启动恢复；同一 Run 最终 `completed`；全部必需 Contract 通过；Checkpoint hash 全部有效；外部副作用、工具调用、assistant 消息和 `run.completed` 均恰好一次；事件 ID 严格递增。",
            "",
            "## 限制",
            "",
            "- 使用确定性离线 Driver，避免把 LLM/Tavily/Neo4j 的波动混入恢复指标。",
            "- 注入点位于阶段安全 Checkpoint 提交后，未覆盖 SQLite 提交中途的磁盘损坏、操作系统断电或跨机器恢复。",
            "- 租约 TTL 为 1 秒以缩短评测时间；生产默认租约更长，因此生产自动接管时间会相应增加。",
            "- 样本量有限，100% 点估计不代表真实总体必然为 100%，应结合 Wilson 区间解释。",
            "- `native-evaluator-summary.json` 是项目原生 EvaluationService 对同一 SQLite 轨迹的独立重算结果。",
            "",
            "原始逐 Run 数据见同目录 JSON。",
            "",
        ]
    )
    return "\n".join(lines)


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    database_path = output_dir / "recovery-e2e.db"
    if database_path.exists():
        database_path.unlink()
    database_url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
    artifact_root = output_dir / "artifacts"
    skills_root = output_dir / "skills"
    ctx = multiprocessing.get_context("spawn")
    cases: list[dict[str, Any]] = []

    for stage in args.stage:
        for repetition in range(1, args.repetitions + 1):
            marker = output_dir / "side-effects" / f"{stage}-{repetition}.log"
            run_id = await _create_run(database_url, stage, repetition, marker)
            started = time.perf_counter()
            crash = ctx.Process(
                target=_crash_worker,
                args=(database_url, str(artifact_root), run_id, stage),
            )
            crash.start()
            crash.join(args.process_timeout_seconds)
            if crash.is_alive():
                crash.terminate()
                crash.join()

            time.sleep(args.lease_wait_seconds)
            resume = ctx.Process(
                target=_resume_worker,
                args=(database_url, str(artifact_root), str(skills_root)),
            )
            resume.start()
            resume.join(args.process_timeout_seconds)
            if resume.is_alive():
                resume.terminate()
                resume.join()
            recovery_latency_ms = (time.perf_counter() - started) * 1000

            inspected = await _inspect_run(database_url, run_id, marker)
            case = {
                "stage": stage,
                "repetition": repetition,
                "crash_exit_code": crash.exitcode,
                "resume_exit_code": resume.exitcode,
                "recovery_latency_ms": recovery_latency_ms,
                **inspected,
            }
            case["passed"] = _case_passed(case)
            cases.append(case)
            print(
                f"[{len(cases):02d}/{len(args.stage) * args.repetitions}] "
                f"stage={stage} repetition={repetition} passed={case['passed']} "
                f"latency_ms={recovery_latency_ms:.1f}",
                flush=True,
            )

    attempts = len(cases)
    successes = sum(case["passed"] for case in cases)
    ci_low, ci_high = _wilson_interval(successes, attempts)
    latencies = sorted(case["recovery_latency_ms"] for case in cases)

    def percentile(proportion: float) -> float:
        if not latencies:
            return 0.0
        position = (len(latencies) - 1) * proportion
        lower = int(position)
        upper = min(lower + 1, len(latencies) - 1)
        fraction = position - lower
        return latencies[lower] * (1 - fraction) + latencies[upper] * fraction

    checkpoint_total = sum(case["checkpoint_count"] for case in cases)
    valid_checkpoints = sum(
        case["checkpoint_count"] * case["checkpoint_integrity_rate"] for case in cases
    )
    tool_calls = sum(case["tool_call_count"] for case in cases)
    duplicate_side_effects = sum(
        case["tool_call_count"] * case["duplicate_side_effect_rate"] for case in cases
    )
    summary = {
        "attempts": attempts,
        "successes": successes,
        "recovery_success_rate": successes / attempts if attempts else 0.0,
        "recovery_success_ci_95": [ci_low, ci_high],
        "checkpoint_integrity_rate": valid_checkpoints / checkpoint_total if checkpoint_total else 0.0,
        "duplicate_side_effect_rate": duplicate_side_effects / tool_calls if tool_calls else 0.0,
        "exactly_once_assistant_rate": sum(case["assistant_message_count"] == 1 for case in cases) / attempts,
        "event_sequence_integrity_rate": sum(
            case["event_ids_strictly_increasing"]
            and case["run_interrupted_events"] == 1
            and case["run_resumed_events"] == 1
            and case["run_completed_events"] == 1
            for case in cases
        ) / attempts,
        "recovery_latency_p50_ms": percentile(0.50),
        "recovery_latency_p95_ms": percentile(0.95),
    }
    by_stage: dict[str, Any] = {}
    for stage in args.stage:
        selected = [case for case in cases if case["stage"] == stage]
        stage_successes = sum(case["passed"] for case in selected)
        by_stage[stage] = {
            "attempts": len(selected),
            "successes": stage_successes,
            "success_rate": stage_successes / len(selected),
        }

    return {
        "schema_version": 1,
        "executed_at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "method": {
            "crash": "os._exit after durable stage checkpoint",
            "recovery": "fresh process RunService.startup_recovery(auto_resume=True)",
            "lease_seconds": 1,
            "lease_wait_seconds": args.lease_wait_seconds,
            "stages": args.stage,
            "repetitions_per_stage": args.repetitions,
            "driver": "deterministic offline",
        },
        "summary": summary,
        "by_stage": by_stage,
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate hard-crash Harness recovery end to end")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "output" / "evaluation" / "recovery-e2e",
    )
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument(
        "--stage",
        action="append",
        choices=TERMINAL_STAGES,
        help="Checkpoint after which to hard-exit; repeat for multiple stages",
    )
    parser.add_argument("--lease-wait-seconds", type=float, default=1.25)
    parser.add_argument("--process-timeout-seconds", type=float, default=30.0)
    args = parser.parse_args()
    args.stage = args.stage or list(TERMINAL_STAGES)
    if args.repetitions < 1:
        parser.error("--repetitions must be >= 1")

    payload = asyncio.run(_run(args))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "results.json"
    report_path = args.output_dir / "REPORT.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report_path.write_text(_render_markdown(payload), encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))
    print(f"JSON: {json_path.resolve()}")
    print(f"Report: {report_path.resolve()}")
    if payload["summary"]["successes"] != payload["summary"]["attempts"]:
        raise SystemExit(1)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
