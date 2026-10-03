"""
审核状态机（Review Workflow）
统一管理 Bug 复盘文档的审核生命周期：

状态流转：
    draft  -->  pending  -->  approved  -->  published
     |                         |
     +-------- rejected <------+

每个状态变更都会记录审核历史（ReviewRecord），支持完整的审计追溯。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from .flow_debug import flow_log
from .models import iso_now


class ReviewStatus(str, Enum):
    DRAFT = "draft"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    PUBLISHED = "published"


ALLOWED_TRANSITIONS: dict[ReviewStatus, set[ReviewStatus]] = {
    ReviewStatus.DRAFT: {ReviewStatus.PENDING, ReviewStatus.REJECTED},
    ReviewStatus.PENDING: {ReviewStatus.APPROVED, ReviewStatus.REJECTED},
    ReviewStatus.APPROVED: {ReviewStatus.PUBLISHED, ReviewStatus.REJECTED},
    ReviewStatus.REJECTED: {ReviewStatus.PENDING, ReviewStatus.DRAFT},
    ReviewStatus.PUBLISHED: set(),
}


@dataclass
class ReviewRecord:
    """单条审核操作记录"""
    id: str
    bug_report_id: str
    action: Literal["submit", "approve", "reject", "publish", "auto_classify"]
    reviewer: str
    notes: str = ""
    from_status: str = ""
    to_status: str = ""
    created_at: str = field(default_factory=iso_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "bug_report_id": self.bug_report_id,
            "action": self.action,
            "reviewer": self.reviewer,
            "notes": self.notes,
            "from_status": self.from_status,
            "to_status": self.to_status,
            "created_at": self.created_at,
        }


class ReviewWorkflowEngine:
    """审核状态机引擎"""

    def __init__(self, storage_dir: Path | None = None) -> None:
        if storage_dir is None:
            storage_dir = Path(".review_logs")
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self._records_path = self.storage_dir / "review_records.json"
        self._records: dict[str, list[ReviewRecord]] = self._load_records()

    # --- state transition (core) ------------------------------------------------

    def transition(
        self,
        *,
        bug_report_id: str,
        to_status: ReviewStatus | str,
        reviewer: str = "system",
        notes: str = "",
        action: str | None = None,
        current_status: ReviewStatus | str | None = None,
    ) -> tuple[bool, str, ReviewStatus | None]:
        """Try to execute a state transition.  Returns (success, message, new_status)."""
        target = ReviewStatus(to_status) if isinstance(to_status, str) else to_status

        if current_status is None:
            history = self._records.get(bug_report_id, [])
            current = ReviewStatus(history[-1].to_status) if history else ReviewStatus.DRAFT
        else:
            current = ReviewStatus(current_status) if isinstance(current_status, str) else current_status

        allowed = ALLOWED_TRANSITIONS.get(current, set())
        if target not in allowed and current != target:
            return (
                False,
                f"Transition {current.value} -> {target.value} not allowed (allowed: {', '.join(s.value for s in allowed)})",
                current,
            )

        inferred_action = action or self._infer_action(target)

        record_id = f"review_{bug_report_id}_{int(datetime.now(timezone.utc).timestamp())}"
        record = ReviewRecord(
            id=record_id,
            bug_report_id=bug_report_id,
            action=inferred_action,
            reviewer=reviewer,
            notes=notes,
            from_status=current.value,
            to_status=target.value,
        )
        self._records.setdefault(bug_report_id, []).append(record)
        self._save_records()

        flow_log(
            "review_workflow.transition",
            bug_report_id=bug_report_id,
            from_status=current.value,
            to_status=target.value,
            reviewer=reviewer,
        )
        return True, f"{current.value} -> {target.value}", target

    # --- convenience methods ----------------------------------------------------

    def submit_for_review(self, bug_report_id: str, reviewer: str = "system") -> tuple[bool, str]:
        success, msg, _ = self.transition(
            bug_report_id=bug_report_id,
            to_status=ReviewStatus.PENDING,
            reviewer=reviewer,
            action="submit",
        )
        return success, msg

    def approve(self, bug_report_id: str, reviewer: str = "admin", notes: str = "") -> tuple[bool, str]:
        success, msg, _ = self.transition(
            bug_report_id=bug_report_id,
            to_status=ReviewStatus.APPROVED,
            reviewer=reviewer,
            notes=notes,
            action="approve",
        )
        return success, msg

    def reject(self, bug_report_id: str, reviewer: str = "admin", notes: str = "") -> tuple[bool, str]:
        if not notes.strip():
            return False, "Rejection requires a reason (notes)"
        success, msg, _ = self.transition(
            bug_report_id=bug_report_id,
            to_status=ReviewStatus.REJECTED,
            reviewer=reviewer,
            notes=notes,
            action="reject",
        )
        return success, msg

    def publish(self, bug_report_id: str, reviewer: str = "system") -> tuple[bool, str]:
        success, msg, _ = self.transition(
            bug_report_id=bug_report_id,
            to_status=ReviewStatus.PUBLISHED,
            reviewer=reviewer,
            action="publish",
        )
        return success, msg

    # --- queries -----------------------------------------------------------------

    def get_history(self, bug_report_id: str) -> list[dict[str, Any]]:
        return [r.to_dict() for r in self._records.get(bug_report_id, [])]

    def get_current_status(self, bug_report_id: str) -> ReviewStatus:
        records = self._records.get(bug_report_id, [])
        return ReviewStatus.DRAFT if not records else ReviewStatus(records[-1].to_status)

    def list_pending_reviews(self) -> list[str]:
        return [
            bug_id for bug_id, records in self._records.items()
            if records and records[-1].to_status == ReviewStatus.PENDING.value
        ]

    def list_approved(self) -> list[str]:
        return [
            bug_id for bug_id, records in self._records.items()
            if records and records[-1].to_status == ReviewStatus.APPROVED.value
        ]

    def get_stats(self) -> dict[str, int]:
        stats: dict[str, int] = {s.value: 0 for s in ReviewStatus}
        for records in self._records.values():
            if records:
                status = records[-1].to_status
                stats[status] = stats.get(status, 0) + 1
        return stats

    # --- internal ----------------------------------------------------------------

    def _infer_action(self, target: ReviewStatus) -> str:
        return {
            ReviewStatus.DRAFT: "auto_classify",
            ReviewStatus.PENDING: "submit",
            ReviewStatus.APPROVED: "approve",
            ReviewStatus.REJECTED: "reject",
            ReviewStatus.PUBLISHED: "publish",
        }.get(target, "auto_classify")

    def _load_records(self) -> dict[str, list[ReviewRecord]]:
        if not self._records_path.exists():
            return {}
        try:
            raw = json.loads(self._records_path.read_text(encoding="utf-8"))
            result: dict[str, list[ReviewRecord]] = {}
            for bug_id, recs in raw.items():
                result[bug_id] = [
                    ReviewRecord(
                        id=r["id"], bug_report_id=r["bug_report_id"],
                        action=r["action"], reviewer=r["reviewer"],
                        notes=r.get("notes", ""),
                        from_status=r.get("from_status", ""),
                        to_status=r.get("to_status", ""),
                        created_at=r.get("created_at", iso_now()),
                    )
                    for r in recs
                ]
            return result
        except (json.JSONDecodeError, KeyError, TypeError):
            return {}

    def _save_records(self) -> None:
        data = {bug_id: [r.to_dict() for r in records] for bug_id, records in self._records.items()}
        temporary = self._records_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._records_path)

    def clear_history(self, bug_report_id: str) -> None:
        self._records.pop(bug_report_id, None)
        self._save_records()