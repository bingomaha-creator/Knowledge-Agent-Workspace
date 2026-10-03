"""Deterministic Run lifecycle with an explicit completion gate."""

from __future__ import annotations

from dataclasses import dataclass

from .contracts import RunStatus


class InvalidTransition(ValueError):
    pass


@dataclass(frozen=True)
class StateMachine:
    transitions = {
        RunStatus.QUEUED: {RunStatus.CONTEXT_BUILDING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED},
        RunStatus.CONTEXT_BUILDING: {RunStatus.PLANNING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.PLANNING: {RunStatus.EXECUTING, RunStatus.PAUSED, RunStatus.NEEDS_USER_INPUT, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.EXECUTING: {RunStatus.EXECUTING, RunStatus.RETRYING, RunStatus.REPLANNING, RunStatus.REPORTING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.RETRYING: {RunStatus.EXECUTING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.REPORTING: {RunStatus.VERIFYING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.VERIFYING: {RunStatus.COMPLETED, RunStatus.REPLANNING, RunStatus.REPORTING, RunStatus.PAUSED, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.REPLANNING: {RunStatus.EXECUTING, RunStatus.PAUSED, RunStatus.NEEDS_USER_INPUT, RunStatus.CANCELLING, RunStatus.INTERRUPTED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED},
        RunStatus.CANCELLING: {RunStatus.CANCELLED},
        RunStatus.INTERRUPTED: {
            RunStatus.QUEUED, RunStatus.PLANNING, RunStatus.EXECUTING,
            RunStatus.REPORTING, RunStatus.VERIFYING, RunStatus.FAILED,
        },
        RunStatus.PAUSED: {
            RunStatus.QUEUED, RunStatus.CONTEXT_BUILDING, RunStatus.PLANNING,
            RunStatus.EXECUTING, RunStatus.REPORTING, RunStatus.VERIFYING,
            RunStatus.RETRYING, RunStatus.REPLANNING, RunStatus.CANCELLING,
        },
        RunStatus.NEEDS_USER_INPUT: {RunStatus.QUEUED, RunStatus.CANCELLING, RunStatus.FAILED},
    }
    terminal = frozenset({RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.BUDGET_EXHAUSTED, RunStatus.CANCELLED})

    def validate(self, current: RunStatus | str, target: RunStatus | str, *, contract_passed: bool = False) -> None:
        source = RunStatus(current)
        destination = RunStatus(target)
        if destination not in self.transitions.get(source, set()):
            raise InvalidTransition(f"非法 Run 状态转换: {source.value} -> {destination.value}")
        if destination is RunStatus.COMPLETED and not contract_passed:
            raise InvalidTransition("Completion Contract 未通过，禁止进入 completed")

    def is_terminal(self, status: RunStatus | str) -> bool:
        return RunStatus(status) in self.terminal
