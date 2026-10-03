"""Token-pressure driven structured Session compaction."""

from __future__ import annotations

import json

from deepresearch_agent.persistence.repositories import MessageRepository, SessionRepository

from .tokens import count_tokens


class ContextCompactor:
    def __init__(
        self, sessions: SessionRepository, messages: MessageRepository, *,
        threshold_tokens: int = 8000, protect_recent_messages: int = 12,
        target_tokens: int = 2000,
    ):
        self.sessions, self.messages = sessions, messages
        self.threshold_tokens = max(100, threshold_tokens)
        self.protect_recent_messages = max(2, protect_recent_messages)
        self.target_tokens = max(200, target_tokens)

    async def get_or_update(self, session_id: str) -> dict:
        session = await self.sessions.get(session_id)
        if session is None:
            return {}
        messages = [item for item in await self.messages.list_for_session(session_id, limit=500) if item.role in {"user", "assistant"}]
        current = json.loads(session.summary_json or "{}")
        total_tokens = sum(count_tokens(item.content) for item in messages)
        if total_tokens < self.threshold_tokens:
            return current
        middle = messages[:-self.protect_recent_messages]
        if not middle:
            return current
        first_user = next((item for item in messages if item.role == "user"), None)
        decisions, verified, completed, unresolved, constraints, superseded = [], [], [], [], [], []
        for item in middle:
            content = " ".join(item.content.strip().split())[:400]
            if not content:
                continue
            metadata = json.loads(item.metadata_json or "{}")
            if item.role == "user":
                if any(marker in content for marker in ("不要", "必须", "只", "保持", "要求")):
                    constraints.append({"text": content, "message_ids": [item.message_id]})
                if any(marker in content for marker in ("决定", "采用", "改为", "使用")):
                    decisions.append({"text": content, "message_ids": [item.message_id]})
                if any(marker in content for marker in ("停止", "撤销", "不用了", "不要再", "换个主题", "算了")):
                    superseded.append(content)
                unresolved.append(content)
            else:
                completed.append({"text": content, "message_ids": [item.message_id]})
                if metadata.get("verified"):
                    verified.append({
                        "text": content, "message_ids": [item.message_id],
                        "evidence_refs": list(metadata.get("evidence_refs", [])),
                    })
        summary = {
            "goal": "" if first_user is None else first_user.content[:500],
            "decisions": decisions[-8:], "verified_facts": verified[-8:],
            "completed": completed[-8:], "unresolved": unresolved[-5:],
            "constraints": constraints[-8:], "superseded": superseded[-5:],
            "covered_message_ids": [item.message_id for item in middle],
            "message_ids": [item.message_id for item in middle],
            "source_token_count": total_tokens,
        }
        trim_order = ("completed", "verified_facts", "decisions", "unresolved", "constraints", "superseded")
        while count_tokens(json.dumps(summary, ensure_ascii=False)) > self.target_tokens:
            bucket = next((summary[name] for name in trim_order if summary[name]), None)
            if bucket is None:
                break
            bucket.pop(0)
        await self.sessions.update_summary(session_id, summary)
        return summary


SessionSummarizer = ContextCompactor
