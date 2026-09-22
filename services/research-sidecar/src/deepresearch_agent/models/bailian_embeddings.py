"""Alibaba Bailian compatibility adapter for OpenAI-style embeddings."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from langchain_openai import OpenAIEmbeddings


def is_bailian_compatible_url(base_url: str | None) -> bool:
    """Return whether *base_url* targets Bailian's OpenAI-compatible API."""

    if not base_url:
        return False
    hostname = (urlparse(base_url).hostname or "").lower()
    return (
        hostname in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"}
        or hostname.endswith(".maas.aliyuncs.com")
    )


class BailianOpenAIEmbeddings(OpenAIEmbeddings):
    """Keep text inputs intact for Bailian's OpenAI-compatible endpoint.

    LangChain's length-safe path tokenizes strings locally and sends token-id
    arrays to the embeddings endpoint. Bailian accepts strings or lists of
    strings, so disabling that path preserves the documented request shape.
    """

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("check_embedding_ctx_length", False)
        # Bailian text-embedding-v4 accepts at most 10 texts per request.
        # Keep this limit inside the adapter so existing callers may retain
        # their own larger processing batches without changing behavior.
        kwargs.setdefault("chunk_size", 10)
        super().__init__(**kwargs)


__all__ = ["BailianOpenAIEmbeddings", "is_bailian_compatible_url"]
