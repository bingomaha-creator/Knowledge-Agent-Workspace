"""Stable cache identities for corpus graph extraction."""

from __future__ import annotations

import hashlib
import json


def graph_extraction_cache_key(
    text: str,
    *,
    entity_types: list[str],
    relationship_types: list[str],
    system_template: str,
    human_template: str,
    llm_identity: str,
) -> str:
    payload = {
        "version": 2,
        "text": text,
        "entity_types": entity_types,
        "relationship_types": relationship_types,
        "system_template": system_template,
        "human_template": human_template,
        "llm_identity": llm_identity,
    }
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
