"""Optional independent judge for already-sanitized paired evaluation summaries."""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, Field


class SemanticJudgement(BaseModel):
    control_score: float = Field(ge=0, le=1)
    treatment_score: float = Field(ge=0, le=1)
    treatment_regressed: bool
    reasons: list[str] = Field(default_factory=list)


class SemanticJudge(Protocol):
    """Implementations receive sanitized summaries, never raw private reports."""

    async def judge(self, *, case: dict, control: dict, treatment: dict) -> SemanticJudgement: ...
