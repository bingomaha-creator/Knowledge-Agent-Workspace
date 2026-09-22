"""Filesystem-backed Skill registry with durable version metadata."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path

from deepresearch_agent.persistence.repositories import SkillRepository

from .linter import SkillLinter
from .schema import SkillSpec


class SkillRegistry:
    def __init__(self, root: str | Path, repository: SkillRepository, *, linter: SkillLinter | None = None):
        self.root = Path(root).resolve()
        self.repository = repository
        self.linter = linter or SkillLinter()

    def _path(self, name: str, version: str) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,79}", name) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("非法 Skill 名称或版本")
        target = (self.root / "research" / name / version / "SKILL.md").resolve()
        if target != self.root and self.root not in target.parents:
            raise ValueError("Skill 路径越界")
        return target

    def _write(self, target: Path, content: str) -> str:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".skill-", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    async def register_candidate(self, *, run_id: str, spec: SkillSpec, eval_cases: list[dict] | None = None, extra_payload: dict | None = None):
        content = spec.model_copy(update={"status": "candidate"}).render()
        lint = self.linter.lint(spec, content=content)
        payload = {"spec": spec.model_dump(mode="json"), "content": content, "machine_policy": spec.machine_policy, "lint": {"passed": lint.passed, "errors": lint.errors}, "eval_cases": eval_cases or [], **(extra_payload or {})}
        candidate = await self.repository.add_candidate(run_id=run_id, name=spec.name, proposed_version=spec.version, payload=payload)
        if not lint.passed:
            await self.repository.update_candidate_status(candidate.candidate_id, "rejected")
            return candidate
        target = self._path(spec.name, spec.version)
        digest = self._write(target, content)
        await self.repository.add_version(name=spec.name, version=spec.version, content_path=target.relative_to(self.root).as_posix(), content_hash=digest, source_run_ids=spec.created_from_runs, status="candidate")
        return candidate

    async def active_specs(self) -> list[tuple[object, SkillSpec]]:
        output = []
        for version in await self.repository.list_versions(status="active"):
            output.append((version, self.load(version.content_path, expected_hash=version.content_hash)))
        return output

    async def selectable_specs(self, *, run_id: str | None = None) -> list[tuple[object, SkillSpec]]:
        output = await self.active_specs()
        if not run_id:
            return output
        active_names = {spec.name for _, spec in output}
        for version in await self.repository.list_versions(status="canary"):
            deployment = await self.repository.latest_deployment(version.skill_version_id)
            allocation = int(getattr(deployment, "allocation_percent", 0) or 0)
            bucket = int(hashlib.sha256(f"{run_id}:{version.name}".encode()).hexdigest()[:8], 16) % 100
            if bucket >= allocation:
                continue
            spec = self.load(version.content_path, expected_hash=version.content_hash)
            output = [(v, s) for v, s in output if s.name != spec.name]
            output.append((version, spec))
            active_names.add(spec.name)
        return output

    def load(self, relative_path: str, *, expected_hash: str | None = None) -> SkillSpec:
        target = (self.root / relative_path).resolve()
        if self.root not in target.parents:
            raise ValueError("Skill 路径越界")
        text = target.read_text(encoding="utf-8")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if expected_hash is not None and digest != expected_hash:
            raise ValueError("Skill 内容 hash 校验失败")
        return SkillSpec.parse(text)

    def read_text(self, relative_path: str) -> str:
        target = (self.root / relative_path).resolve()
        if self.root not in target.parents:
            raise ValueError("Skill 路径越界")
        return target.read_text(encoding="utf-8")

    def rewrite_status(self, relative_path: str, status: str) -> str:
        spec = self.load(relative_path).model_copy(update={"status": status})
        return self._write((self.root / relative_path).resolve(), spec.render())
