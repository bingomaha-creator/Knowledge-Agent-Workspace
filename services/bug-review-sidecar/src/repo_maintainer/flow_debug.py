from __future__ import annotations

from datetime import datetime, timezone
import json
from queue import Full, Queue
import re
from pathlib import Path
from threading import Lock
from typing import Any, Callable


_SECRET_KEY_RE = re.compile(r"(token|secret|password|authorization|api_key)", re.IGNORECASE)
_AUTH_URL_RE = re.compile(r"://([^:@/\s]+):([^@/\s]+)@")
_EVENTS_PATH: Path | None = None
_EVENTS_LOCK = Lock()
_SUBSCRIBERS: list[tuple[Callable[[dict[str, Any]], bool], Queue[dict[str, Any]]]] = []
_SUBSCRIBERS_LOCK = Lock()


def configure_flow_events(path: str | Path | None) -> None:
    global _EVENTS_PATH
    _EVENTS_PATH = Path(path).resolve() if path is not None else None
    if _EVENTS_PATH is not None:
        _EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)


def sanitize_flow_value(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {
            str(key): "***" if _SECRET_KEY_RE.search(str(key)) else sanitize_flow_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [sanitize_flow_value(item) for item in value]
    if isinstance(value, str):
        return _AUTH_URL_RE.sub(r"://***:***@", value)
    return value


def flow_log(step: str, **payload: Any) -> None:
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "step": step,
        **{key: sanitize_flow_value(value) for key, value in payload.items()},
    }
    try:
        print(f"[repair-flow] {json.dumps(record, ensure_ascii=False, sort_keys=True)}", flush=True)
    except OSError:
        pass
    if _EVENTS_PATH is not None:
        with _EVENTS_LOCK:
            with _EVENTS_PATH.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    _publish_flow_event(record)


def subscribe_flow_events(predicate: Callable[[dict[str, Any]], bool]) -> Queue[dict[str, Any]]:
    queue: Queue[dict[str, Any]] = Queue(maxsize=1000)
    with _SUBSCRIBERS_LOCK:
        _SUBSCRIBERS.append((predicate, queue))
    return queue


def unsubscribe_flow_events(queue: Queue[dict[str, Any]]) -> None:
    with _SUBSCRIBERS_LOCK:
        _SUBSCRIBERS[:] = [(predicate, subscriber) for predicate, subscriber in _SUBSCRIBERS if subscriber is not queue]


def _publish_flow_event(record: dict[str, Any]) -> None:
    with _SUBSCRIBERS_LOCK:
        subscribers = list(_SUBSCRIBERS)
    for predicate, subscriber in subscribers:
        try:
            if predicate(record):
                subscriber.put_nowait(record)
        except (Full, RuntimeError):
            continue
