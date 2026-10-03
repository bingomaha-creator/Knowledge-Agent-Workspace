from __future__ import annotations

import json
import re
from typing import Any

from deepresearch_agent.harness.contracts import ContractCheckData, SourceMode
from deepresearch_agent.harness.report_safety import has_internal_material

_CITATION = re.compile(r"\[\^?(ev_[A-Za-z0-9_-]+)\]")


class DeterministicVerifiers:
    version = "1.1"

    def __init__(self, *, run_id: str, source_mode: SourceMode, report: str, evidence: list[Any]):
        self.run_id = run_id
        self.source_mode = source_mode
        self.report = report or ""
        self.evidence = evidence
        self._by_id = {str(self._get(item, "evidence_id", "")): item for item in evidence}

    @staticmethod
    def _get(item: Any, key: str, default: Any = None) -> Any:
        if isinstance(item, dict):
            return item.get(key, default)
        return getattr(item, key, default)

    def _check(self, kind: str, passed: bool, *, expected: Any, observed: Any, explanation: str, required: bool = True, threshold: float | None = None) -> ContractCheckData:
        return ContractCheckData(
            check_id=f"contract_{self.run_id}_{kind}", run_id=self.run_id, kind=kind,
            required=required, threshold=threshold, verifier="deterministic", verifier_version=self.version,
            passed=passed, observed={"expected": expected, "actual": observed}, explanation=explanation,
        )

    def source_match(self) -> ContractCheckData:
        raw_modes = [self._get(item, "source_mode", "") for item in self.evidence]
        modes = [mode.value if hasattr(mode, "value") else str(mode) for mode in raw_modes]
        passed = all(mode == self.source_mode.value for mode in modes)
        return self._check("source_match", passed, expected=self.source_mode.value, observed=modes, explanation="全部证据必须匹配冻结的 Run source_mode")

    def min_evidence(self, minimum: int) -> ContractCheckData:
        count = len(self.evidence)
        return self._check("min_evidence", count >= minimum, expected=minimum, observed=count, threshold=float(minimum), explanation="有效 Evidence Ledger 记录数量")

    def citation_integrity(self) -> ContractCheckData:
        citations = _CITATION.findall(self.report)
        missing = sorted({citation for citation in citations if citation not in self._by_id})
        claim_lines = self._claim_lines()
        uncited = [line[:160] for line in claim_lines if not _CITATION.search(line)]
        passed = bool(citations) and not missing and not uncited
        return self._check("citation_integrity", passed, expected="每条实质性主张就近引用当前 Run 证据", observed={"citations": citations, "missing": missing, "uncited_claims": uncited}, explanation="解析稳定 evidence_id 并检查主张附近引用")

    def required_section(self, required_sections: list[str]) -> ContractCheckData:
        headings = [match.group(1).strip() for match in re.finditer(r"(?m)^#{1,4}\s+(.+?)\s*$", self.report)]
        missing = [name for name in required_sections if not any(name.lower() in heading.lower() for heading in headings)]
        passed = bool(headings) and not missing and not has_internal_material(self.report)
        return self._check("required_section", passed, expected=required_sections or "至少一个非空 Markdown 标题", observed={"headings": headings, "missing": missing}, explanation="报告必需章节存在且非空")

    def claim_support(self) -> ContractCheckData:
        claims = self._claim_lines()
        supported = [line for line in claims if any(citation in self._by_id for citation in _CITATION.findall(line))]
        passed = bool(claims) and len(supported) == len(claims)
        return self._check("claim_support", passed, expected="每条实质性主张都有当前 Run 证据", observed={"claims": len(claims), "supported": len(supported)}, explanation="以逐段就近引用作为确定性支持下限")

    def report_consistency(self, consistency_passed: bool | None) -> ContractCheckData:
        passed = consistency_passed is True and bool(self.report.strip()) and not has_internal_material(self.report)
        return self._check("report_consistency", passed, expected=True, observed=consistency_passed, explanation="现有 ConsistencyChecker 未报告失败；未配置 LLM 检查时保守依赖确定性检查")

    def source_diversity(self) -> ContractCheckData:
        sources = set()
        cited = set(_CITATION.findall(self.report))
        for item in self.evidence:
            if str(self._get(item, "evidence_id", "")) not in cited:
                continue
            source_id = str(self._get(item, "source_id", ""))
            metadata = self._get(item, "metadata_json", "{}")
            if self.source_mode is SourceMode.WEB:
                try:
                    payload = metadata if isinstance(metadata, dict) else json.loads(metadata or "{}")
                except (TypeError, ValueError):
                    payload = {}
                sources.add(str(payload.get("domain") or source_id))
            else:
                try:
                    payload = metadata if isinstance(metadata, dict) else json.loads(metadata or "{}")
                except (TypeError, ValueError):
                    payload = {}
                extra = payload.get("extra") if isinstance(payload.get("extra"), dict) else {}
                sources.add(str(extra.get("document_id") or payload.get("title") or source_id))
        sources.discard("")
        limitation = bool(re.search(r"局限|限制|single[- ]source|limited", self.report, re.I))
        passed = len(sources) >= 2 or (bool(sources) and limitation)
        return self._check("source_diversity", passed, expected="至少两个独立来源，或明确披露单一来源局限", observed={"sources": sorted(sources), "limitation_disclosed": limitation}, explanation="来源不足不得伪造多样性")

    def evidence_card_coverage(self, coverage: dict[str, Any]) -> ContractCheckData:
        ledger_ids = set(coverage.get("ledger_ids") or [])
        card_ids = set(coverage.get("card_ids") or [])
        routed_ids = set(coverage.get("routed_ids") or [])
        processed_ids = set(coverage.get("processed_ids") or [])
        annex_ids = set(coverage.get("annex_ids") or [])
        missing = {
            "cards": sorted(ledger_ids - card_ids),
            "routed": sorted(ledger_ids - routed_ids),
            "processed": sorted(ledger_ids - processed_ids),
            "annex": sorted(ledger_ids - annex_ids),
        }
        exact_sets = (
            ledger_ids == card_ids == routed_ids == processed_ids == annex_ids
        )
        reported_card_count = int(coverage.get("card_count", len(card_ids)) or 0)
        passed = (
            bool(ledger_ids)
            and exact_sets
            and reported_card_count == len(ledger_ids)
            and all(not values for values in missing.values())
        )
        return self._check(
            "evidence_card_coverage",
            passed,
            expected="Ledger/Card/路由/处理/结构化证据索引的 Evidence ID 集合完全一致",
            observed={
                "ledger_count": len(ledger_ids),
                "card_count": reported_card_count,
                "unique_card_count": len(card_ids),
                "routed_count": len(routed_ids),
                "processed_count": len(processed_ids),
                "annex_count": len(annex_ids),
                "missing_by_stage": missing,
            },
            explanation="全量 Evidence Card 保存在结构化证据台账中；正文只需引用支撑结论的证据",
        )

    def _claim_lines(self) -> list[str]:
        claims: list[str] = []
        excluded_section = False
        lines = self.report.splitlines()
        consumed_lines: set[int] = set()
        for index, raw in enumerate(lines):
            if index in consumed_lines:
                continue
            line = raw.strip()
            if line.startswith("#"):
                excluded_section = bool(re.search(r"局限|限制|方法|证据引用|参考来源", line, re.I))
                continue
            if excluded_section or len(line) < 12 or line.startswith(("```", "|")):
                continue
            if re.search(r"局限|证据引用|参考来源|基于证据[。.]?$", line, re.I):
                continue
            if re.fullmatch(r"[-*+]\s+\*\*[^*]+\*\*[：:]", line):
                following = next((item for item in lines[index + 1:] if item.strip()), "")
                if (len(following) - len(following.lstrip()) > len(raw) - len(raw.lstrip())
                    and re.match(r"(?:\d+[.)]|[-*+])\s+", following.strip())):
                    continue  # Structural parent label; its child claims are checked normally.
            # ponytail: only adjacent quotes or indented list continuations;
            # this recognizes Markdown structure, not semantic support.
            unit = [line]
            indentation = len(raw) - len(raw.lstrip())
            list_marker = re.match(r"(?:\d+[.)]|[-*+])\s+", line)
            for following_index in range(index + 1, len(lines)):
                following = lines[following_index]
                text = following.strip()
                depth = len(following) - len(following.lstrip())
                if not text or re.match(r"(?:#{1,6}\s|```|~~~|\||(?:\d+[.)]|[-*+])\s)", text):
                    break
                attached_quote = text.startswith(">") and depth >= indentation
                continuation = list_marker and depth >= indentation + len(list_marker.group())
                if not (attached_quote or continuation):
                    break
                unit.append(text)
                consumed_lines.add(following_index)
            claims.append("\n".join(unit))
        return claims
