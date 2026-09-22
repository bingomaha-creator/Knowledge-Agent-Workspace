"""Pure metric functions that are reusable by tests and offline benchmarks."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

from pydantic import BaseModel


class RetrievalMetrics(BaseModel):
    k: int
    relevant_total: int
    retrieved_total: int
    hits: int
    precision_at_k: float
    recall_at_k: float
    reciprocal_rank: float
    ndcg_at_k: float


def retrieval_metrics(
    retrieved_ids: Sequence[str], relevant_ids: Iterable[str], *, k: int = 10
) -> RetrievalMetrics:
    """Compute binary-relevance Precision/Recall/MRR/nDCG for one query.

    IDs are de-duplicated without changing retrieval order. Empty gold labels
    deliberately produce zero scores instead of pretending the run was good.
    """
    if k < 1:
        raise ValueError("k 必须大于等于 1")
    gold = {str(item) for item in relevant_ids if str(item)}
    ranked: list[str] = []
    seen: set[str] = set()
    for item in retrieved_ids:
        value = str(item)
        if value and value not in seen:
            ranked.append(value)
            seen.add(value)
    top = ranked[:k]
    relevance = [1 if item in gold else 0 for item in top]
    hits = sum(relevance)
    first_rank = next((index + 1 for index, value in enumerate(relevance) if value), None)
    dcg = sum(value / math.log2(index + 2) for index, value in enumerate(relevance))
    ideal_hits = min(len(gold), k)
    idcg = sum(1.0 / math.log2(index + 2) for index in range(ideal_hits))
    return RetrievalMetrics(
        k=k,
        relevant_total=len(gold),
        retrieved_total=len(top),
        hits=hits,
        precision_at_k=hits / k,
        recall_at_k=hits / len(gold) if gold else 0.0,
        reciprocal_rank=1.0 / first_rank if first_rank else 0.0,
        ndcg_at_k=dcg / idcg if idcg else 0.0,
    )
