"""Durable-first event publication; phase 4 can subscribe for SSE."""

from __future__ import annotations

import inspect
from collections import defaultdict
from typing import Any, Awaitable, Callable, DefaultDict

from backend.app.schemas import RunEventCreate
from deepresearch_agent.persistence.repositories import EventRepository

Subscriber = Callable[[Any], Awaitable[None] | None]


class EventBus:
    def __init__(self, repository: EventRepository):
        self.repository = repository
        self._subscribers: DefaultDict[str, list[Subscriber]] = defaultdict(list)

    def subscribe(self, run_id: str, callback: Subscriber) -> Callable[[], None]:
        self._subscribers[run_id].append(callback)
        return lambda: self._subscribers[run_id].remove(callback)

    async def publish(self, run_id: str, event_type: str, *, stage: str | None = None, payload: dict[str, Any] | None = None):
        event = await self.repository.append(RunEventCreate(run_id=run_id, event_type=event_type, stage=stage, payload=payload or {}))
        for callback in tuple(self._subscribers.get(run_id, ())):
            outcome = callback(event)
            if inspect.isawaitable(outcome):
                await outcome
        return event

