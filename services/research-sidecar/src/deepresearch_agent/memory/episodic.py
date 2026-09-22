"""Episodic memory is a searchable view of durable messages and Runs."""

from __future__ import annotations

from dataclasses import dataclass

from deepresearch_agent.persistence.repositories import MessageRepository, RunRepository


@dataclass(frozen=True)
class EpisodicHit:
    message_id: str
    run_id: str | None
    role: str
    content: str


class EpisodicMemory:
    def __init__(self, messages: MessageRepository, runs: RunRepository):
        self.messages, self.runs = messages, runs

    async def search(self, query: str, *, session_id: str, limit: int = 8) -> list[EpisodicHit]:
        try:
            rows = await self.messages.search(query, session_id=session_id, limit=limit)
        except Exception:
            # FTS syntax should never prevent the main chain from running.
            rows = await self.messages.list_for_session(session_id, limit=500)
            rows = [row for row in rows if query.lower() in row.content.lower()][-limit:]
        return [EpisodicHit(row.message_id, row.run_id, row.role, row.content) for row in rows]

