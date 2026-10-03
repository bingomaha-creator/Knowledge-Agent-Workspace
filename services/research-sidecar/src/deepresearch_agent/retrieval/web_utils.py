"""Stable and privacy-safe Web provenance helpers."""

from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_TRACKING_KEYS = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src"}
_SENSITIVE_KEYS = {"api_key", "apikey", "key", "token", "access_token", "auth", "authorization", "signature"}


def normalize_url(url: str) -> str:
    value = (url or "").strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        raise ValueError("Web 证据 URL 必须使用 http 或 https")
    host = (parts.hostname or "").lower()
    port = parts.port
    if port and not ((parts.scheme.lower() == "http" and port == 80) or (parts.scheme.lower() == "https" and port == 443)):
        host = f"{host}:{port}"
    query = urlencode(
        sorted(
            (key, val)
            for key, val in parse_qsl(parts.query, keep_blank_values=True)
            if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_KEYS and key.lower() not in _SENSITIVE_KEYS
        ),
        doseq=True,
    )
    path = parts.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit((parts.scheme.lower(), host, path, query, ""))


def normalize_content(content: str) -> str:
    return re.sub(r"\s+", " ", (content or "").strip())


def content_hash(content: str) -> str:
    return hashlib.sha256(normalize_content(content).encode("utf-8")).hexdigest()


def domain_from_url(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


__all__ = ["content_hash", "domain_from_url", "normalize_content", "normalize_url"]
