"""Build bounded context for editing one report section without rewriting others."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MarkdownSection:
    heading: str
    level: int
    content: str
    sha256: str


class ArtifactEditContextBuilder:
    EDIT_SIGNAL = re.compile(r"(?:修改|改写|重写|补充|完善|不满意|不要修改其他|保持其他|只改|section|revise|rewrite)", re.I)
    HEADING = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")

    def __init__(self, runs, artifacts, store):
        self.runs, self.artifacts, self.store = runs, artifacts, store

    @classmethod
    def parse_sections(cls, report: str) -> list[MarkdownSection]:
        matches = list(cls.HEADING.finditer(report))
        sections: list[MarkdownSection] = []
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(report)
            content = report[match.start():end].strip()
            sections.append(MarkdownSection(
                heading=match.group(2).strip(), level=len(match.group(1)), content=content,
                sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            ))
        return sections

    @staticmethod
    def _select(query: str, sections: list[MarkdownSection]) -> int | None:
        candidates = [index for index, section in enumerate(sections) if section.heading in query or any(part in query for part in re.split(r"[：:—\-、 ]", section.heading) if len(part) >= 3)]
        ordinal = re.search(r"第\s*(\d+)\s*(?:节|部分|章)", query)
        if ordinal:
            number = int(ordinal.group(1))
            numbered = [i for i, section in enumerate(sections) if re.match(rf"{number}(?:\.|、|\s)", section.heading)]
            candidates.extend(numbered)
        unique = sorted(set(candidates))
        return unique[0] if len(unique) == 1 else None

    async def build(self, *, session_id: str, current_run_id: str, query: str) -> dict | None:
        if not self.EDIT_SIGNAL.search(query):
            return None
        prior_runs = [run for run in await self.runs.list_for_session(session_id, limit=50) if run.run_id != current_run_id and run.status == "completed"]
        for run in prior_runs:
            artifact = await self.artifacts.get_report(run.run_id)
            if artifact is None:
                continue
            try:
                report = self.store.read_bytes(artifact.relative_path).decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            sections = self.parse_sections(report)
            selected = self._select(query, sections)
            if selected is None:
                continue
            target = sections[selected]
            preserved = [section for index, section in enumerate(sections) if index != selected]
            return {
                "operation": "replace_section", "artifact_id": artifact.artifact_id,
                "relative_path": artifact.relative_path,
                "base_run_id": run.run_id, "base_sha256": artifact.sha256,
                "target_heading": target.heading, "target_content": target.content,
                "outline": [section.heading for section in sections],
                "previous_section_summary": "" if selected == 0 else sections[selected - 1].content[:500],
                "next_section_summary": "" if selected + 1 >= len(sections) else sections[selected + 1].content[:500],
                "preserve_sections": [{"heading": section.heading, "sha256": section.sha256} for section in preserved],
                "instruction": "只输出目标章节的替换内容；其他章节由程序原样保留，禁止改写。",
            }
        return None

    @classmethod
    def apply_replacement(cls, base_report: str, contract: dict, generated: str) -> str:
        """Deterministically splice one generated section into the base report."""
        base_sections = cls.parse_sections(base_report)
        target = next((section for section in base_sections if section.heading == contract["target_heading"]), None)
        if target is None:
            raise ValueError("Artifact edit target no longer exists in the base report")
        generated_sections = cls.parse_sections(generated)
        replacement = next((section.content for section in generated_sections if section.heading == target.heading), None)
        if replacement is None:
            marker = "#" * target.level
            replacement = f"{marker} {target.heading}\n\n{generated.strip()}"
        merged = base_report.replace(target.content, replacement.strip(), 1)
        merged_hashes = {section.heading: section.sha256 for section in cls.parse_sections(merged)}
        for preserved in contract.get("preserve_sections", []):
            if merged_hashes.get(preserved["heading"]) != preserved["sha256"]:
                raise ValueError(f"Artifact edit modified preserved section: {preserved['heading']}")
        return merged
