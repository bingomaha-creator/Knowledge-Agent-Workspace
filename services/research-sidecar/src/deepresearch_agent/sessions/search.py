"""Hermes-style FTS session discovery, scrolling, reading and browsing."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from deepresearch_agent.persistence.repositories import MessageRepository, SessionRepository


@dataclass(frozen=True)
class MessageView:
    message_id: str
    role: str
    content: str
    created_at: str
    anchor: bool = False


@dataclass(frozen=True)
class SessionSearchResult:
    session_id: str
    title: str
    snippet: str
    match_message_id: str
    detail: str
    bookend_start: list[dict]
    messages: list[dict]
    bookend_end: list[dict]
    messages_before: int
    messages_after: int

    def to_dict(self) -> dict:
        return asdict(self)


class SessionSearchService:
    HISTORY_SIGNAL = re.compile(
        r"(?:之前|上次|以前|过去|曾经|我们讨论过|还记得|继续(?:那个|之前)|last time|previous(?:ly)?|remember when)",
        re.I,
    )

    def __init__(self, messages: MessageRepository, sessions: SessionRepository):
        self.messages, self.sessions = messages, sessions

    @classmethod
    def should_search(cls, query: str, *, unresolved_reference: bool = False) -> bool:
        return unresolved_reference or bool(cls.HISTORY_SIGNAL.search(query))

    @staticmethod
    def _view(item, *, anchor_id: str | None = None) -> dict:
        return asdict(MessageView(
            message_id=item.message_id, role=item.role, content=item.content,
            created_at=item.created_at, anchor=item.message_id == anchor_id,
        ))

    async def search(
        self, query: str, *, limit: int = 3, window: int = 5,
        exclude_session_id: str | None = None, detail: str = "adaptive",
    ) -> list[SessionSearchResult]:
        cleaned_query = self.HISTORY_SIGNAL.sub(" ", query)
        cleaned_query = re.sub(r"(?:我们|讨论|继续|那个|一下|相关|内容|问题|的)", " ", cleaned_query)
        cleaned_query = " ".join(cleaned_query.split()) or query
        terms = re.findall(r"[A-Za-z0-9_]{2,}|[\u3400-\u9fff]{2,}", cleaned_query)
        fts_query = " OR ".join(f'"{term}"' for term in terms[:12]) or cleaned_query
        try:
            hits = await self.messages.search(fts_query, limit=max(limit * 8, 20))
        except Exception:
            hits = []
        grouped: dict[str, object] = {}
        for hit in hits:
            if hit.role not in {"user", "assistant"} or hit.session_id == exclude_session_id:
                continue
            grouped.setdefault(hit.session_id, hit)
            if len(grouped) >= limit:
                break
        results: list[SessionSearchResult] = []
        for index, (session_id, anchor) in enumerate(grouped.items()):
            session = await self.sessions.get(session_id)
            if session is None:
                continue
            hydrate = detail == "full" or (detail == "adaptive" and index == 0)
            all_messages = [item for item in await self.messages.list_for_session(session_id, limit=500) if item.role in {"user", "assistant"}]
            anchor_index = next((i for i, item in enumerate(all_messages) if item.message_id == anchor.message_id), 0)
            if hydrate:
                start, end = max(0, anchor_index - window), min(len(all_messages), anchor_index + window + 1)
                message_window = [self._view(item, anchor_id=anchor.message_id) for item in all_messages[start:end]]
                bookend_start = [self._view(item) for item in all_messages[:3]]
                bookend_end = [self._view(item) for item in all_messages[-3:]]
                result_detail = "full"
            else:
                message_window = [self._view(anchor, anchor_id=anchor.message_id)]
                bookend_start, bookend_end, result_detail = [], [], "compact"
            results.append(SessionSearchResult(
                session_id=session_id, title=session.title,
                snippet=anchor.content[:300], match_message_id=anchor.message_id,
                detail=result_detail, bookend_start=bookend_start, messages=message_window,
                bookend_end=bookend_end, messages_before=anchor_index,
                messages_after=max(0, len(all_messages) - anchor_index - 1),
            ))
        return results

    async def around(self, session_id: str, message_id: str, *, window: int = 10) -> dict:
        items = [item for item in await self.messages.list_for_session(session_id, limit=500) if item.role in {"user", "assistant"}]
        index = next((i for i, item in enumerate(items) if item.message_id == message_id), -1)
        if index < 0:
            return {"session_id": session_id, "messages": [], "messages_before": 0, "messages_after": 0}
        start, end = max(0, index - window), min(len(items), index + window + 1)
        return {
            "session_id": session_id,
            "messages": [self._view(item, anchor_id=message_id) for item in items[start:end]],
            "messages_before": index, "messages_after": max(0, len(items) - index - 1),
        }

    async def read(self, session_id: str, *, limit: int = 100) -> dict:
        session = await self.sessions.get(session_id)
        if session is None:
            return {"session_id": session_id, "messages": []}
        all_items = [item for item in await self.messages.list_for_session(session_id, limit=500) if item.role in {"user", "assistant"}]
        bounded_limit = max(2, min(500, limit))
        truncated = len(all_items) > bounded_limit
        if truncated:
            head = bounded_limit // 2
            items = all_items[:head] + all_items[-(bounded_limit - head):]
        else:
            items = all_items
        return {
            "session_id": session_id, "title": session.title,
            "messages": [self._view(item) for item in items], "truncated": truncated,
            "total_messages": len(all_items),
        }

    async def browse(self, *, limit: int = 20) -> list[dict]:
        items = await self.sessions.list(limit=limit, offset=0, include_archived=True)
        return [{"session_id": item.session_id, "title": item.title, "status": item.status, "updated_at": item.updated_at} for item in items]
