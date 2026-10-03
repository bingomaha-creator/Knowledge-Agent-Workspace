"""
Bug 复盘标准 Schema 定义
对齐上游 Insight-agent-yuan 愿景：Bug 修复复盘 → 团队踩坑知识库自动化沉淀管道

核心数据结构：BugReviewDocument（标准输出产物）
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any, Literal


# ===== 来源引用（用于反幻觉约束）=====
@dataclass
class SourceRef:
    """来源引用（强制 LLM 输出绑定原始证据，防幻觉）"""
    type: Literal["pr_comment", "commit_message", "log", "chat", "manual"]
    location: str       # 如 "PR #1234 comment by @alice"
    snippet: str        # 原文片段（LLM 必须引用真实原文）

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceRef":
        return cls(
            type=data.get("type", "manual"),
            location=data.get("location", ""),
            snippet=data.get("snippet", ""),
        )


# ===== 根本原因（绑定来源）=====
@dataclass
class RootCause:
    """根本原因（强制绑定来源，防止 LLM 凭空捏造）"""
    content: str
    source: SourceRef   # 强制绑定来源

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "source": self.source.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RootCause":
        return cls(
            content=data.get("content", ""),
            source=SourceRef.from_dict(data.get("source", {})),
        )


# ===== 影响评估 =====
@dataclass
class Impact:
    """Bug 影响评估"""
    scope: str                                          # 影响范围（如 "用户登录模块"）
    affected_users: str | None                          # 受影响用户量（如 "全量用户"）
    severity: Literal["P0", "P1", "P2", "P3", "unknown"]  # 严重程度；未确认不能自动评级

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "affected_users": self.affected_users,
            "severity": self.severity,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Impact":
        return cls(
            scope=data.get("scope", ""),
            affected_users=data.get("affected_users"),
            severity=data.get("severity", "P2"),
        )


# ===== Bug 复盘文档（核心标准输出结构）=====
@dataclass
class BugReviewDocument:
    """
    Bug 复盘文档（对齐上游 README 的标准输出结构）

    生命周期：
    draft → pending（提交审核）→ approved（审核通过）→ published（发布 Wiki）
                                → rejected（驳回修改）
    """
    title: str
    root_cause: RootCause
    impact: Impact
    fix_solution: str
    prevention: str
    related_modules: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)

    # 质量与追溯
    confidence: float = 0.0             # AI 可信度 [0-1]
    source_refs: list[SourceRef] = field(default_factory=list)

    # 审核相关
    review_status: Literal["draft", "pending", "approved", "rejected"] = "draft"
    reviewer_notes: str = ""
    reviewer: str = ""
    reviewed_at: str = ""

    # 发布相关
    wiki_url: str = ""
    published_at: str = ""

    # 元数据
    bug_id: str = ""                    # 关联的 BugReport ID
    trace_id: str = ""                  # 关联的 ExecutionTrace ID
    created_at: str = ""
    updated_at: str = ""

    symptom: str = ""
    validation: str = "未提供验证依据"
    completeness: str = "incomplete"
    gaps: list[str] = field(default_factory=list)
    basis: str = "inference"
    # Generation-only evidence; the pipeline stores it with the material snapshot.
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symptom": self.symptom, "validation": self.validation,
            "completeness": self.completeness, "gaps": self.gaps,
            "basis": self.basis,
            "evidence": self.evidence,
            "title": self.title,
            "root_cause": self.root_cause.to_dict(),
            "impact": self.impact.to_dict(),
            "fix_solution": self.fix_solution,
            "prevention": self.prevention,
            "related_modules": self.related_modules,
            "keywords": self.keywords,
            "confidence": self.confidence,
            "source_refs": [ref.to_dict() for ref in self.source_refs],
            "review_status": self.review_status,
            "reviewer_notes": self.reviewer_notes,
            "reviewer": self.reviewer,
            "reviewed_at": self.reviewed_at,
            "wiki_url": self.wiki_url,
            "published_at": self.published_at,
            "bug_id": self.bug_id,
            "trace_id": self.trace_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BugReviewDocument":
        return cls(
            symptom=data.get("symptom", ""), validation=data.get("validation", "未提供验证依据"),
            completeness=data.get("completeness", "incomplete"), gaps=list(data.get("gaps", [])), basis=data.get("basis", "inference"),
            evidence=data.get("evidence", {}),
            title=data.get("title", ""),
            root_cause=RootCause.from_dict(data.get("root_cause", {})),
            impact=Impact.from_dict(data.get("impact", {})),
            fix_solution=data.get("fix_solution", ""),
            prevention=data.get("prevention", ""),
            related_modules=list(data.get("related_modules", [])),
            keywords=list(data.get("keywords", [])),
            confidence=float(data.get("confidence", 0.0)),
            source_refs=[SourceRef.from_dict(ref) for ref in data.get("source_refs", [])],
            review_status=data.get("review_status", "draft"),
            reviewer_notes=data.get("reviewer_notes", ""),
            reviewer=data.get("reviewer", ""),
            reviewed_at=data.get("reviewed_at", ""),
            wiki_url=data.get("wiki_url", ""),
            published_at=data.get("published_at", ""),
            bug_id=data.get("bug_id", ""),
            trace_id=data.get("trace_id", ""),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
        )

    def to_markdown(self) -> str:
        """生成 Markdown 格式的复盘文档（用于 Wiki 发布）"""
        lines = [
            f"# {self.title}",
            "",
            f"> **严重程度**: {self.impact.severity} | **影响范围**: {self.impact.scope}",
            "",
        ]
        if self.impact.affected_users:
            lines.append(f"> **受影响用户**: {self.impact.affected_users}")
            lines.append("")

        lines += [
            "## 根本原因",
            "",
            self.root_cause.content,
            "",
            f"*来源：{self.root_cause.source.location}*",
            "",
            "```",
            self.root_cause.source.snippet,
            "```",
            "",
            "## 修复方案",
            "",
            self.fix_solution,
            "",
            "## 预防措施",
            "",
            self.prevention,
            "",
        ]

        if self.related_modules:
            lines += [
                "## 涉及模块",
                "",
                "\n".join(f"- {m}" for m in self.related_modules),
                "",
            ]

        if self.keywords:
            lines += [
                "## 关键词",
                "",
                " ".join(f"`{k}`" for k in self.keywords),
                "",
            ]

        if self.source_refs:
            lines += [
                "## 参考来源",
                "",
            ]
            for ref in self.source_refs:
                lines.append(f"- **{ref.type}** @ {ref.location}")
            lines.append("")

        lines += [
            "---",
            "",
            f"*AI 可信度: {self.confidence:.0%} | 审核状态: {self.review_status}*",
        ]

        if self.reviewer:
            lines.append(f"*审核人: {self.reviewer} @ {self.reviewed_at}*")

        return "\n".join(lines)


# ===== JSON Schema（用于约束 LLM 输出格式）=====
BUG_REVIEW_JSON_SCHEMA = {
    "type": "object",
    "required": ["title", "root_cause", "impact", "fix_solution", "prevention"],
    "properties": {
        "title": {
            "type": "string",
            "description": "Bug 复盘标题，简洁描述问题本质"
        },
        "root_cause": {
            "type": "object",
            "required": ["content", "source"],
            "properties": {
                "content": {
                    "type": "string",
                    "description": "根本原因描述，必须基于原始证据"
                },
                "source": {
                    "type": "object",
                    "required": ["type", "location", "snippet"],
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["pr_body", "pr_comment", "commit_message", "diff", "ci", "issue", "log", "chat", "manual"]
                        },
                        "location": {"type": "string"},
                        "snippet": {"type": "string", "description": "必须引用原始文本片段"}
                    }
                }
            }
        },
        "impact": {
            "type": "object",
            "required": ["scope", "severity"],
            "properties": {
                "scope": {"type": "string"},
                "affected_users": {"type": ["string", "null"]},
                "severity": {
                    "type": "string",
                    "enum": ["P0", "P1", "P2", "P3", "unknown"]
                }
            }
        },
        "fix_solution": {
            "type": "string",
            "description": "修复方案描述"
        },
        "prevention": {
            "type": "string",
            "description": "预防措施，避免同类 Bug 再次发生"
        },
        "related_modules": {
            "type": "array",
            "items": {"type": "string"},
            "description": "涉及的模块列表"
        },
        "keywords": {
            "type": "array",
            "items": {"type": "string"},
            "description": "关键词，用于知识库检索"
        },
        "confidence": {
            "type": "number",
            "minimum": 0.0,
            "maximum": 1.0,
            "description": "AI 对本次抽取结果的可信度 [0-1]"
        },
        "source_refs": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["type", "location", "snippet"],
                "properties": {
                    "type": {"type": "string"},
                    "location": {"type": "string"},
                    "snippet": {"type": "string"}
                }
            }
        }
    },
    "additionalProperties": False
}

BUG_REVIEW_JSON_SCHEMA["properties"].update({
    "symptom": {"type": "string"}, "validation": {"type": "string"},
    "completeness": {"type": "string", "enum": ["complete", "incomplete"]},
    "gaps": {"type": "array", "items": {"type": "string"}},
    "basis": {"type": "string", "enum": ["fact", "inference", "human"]},
})

_EVIDENCE_REFS = BUG_REVIEW_JSON_SCHEMA["properties"]["source_refs"]
BUG_REVIEW_JSON_SCHEMA["properties"]["evidence"] = {
    "type": "object",
    "required": ["symptom", "validation", "prevention"],
    "properties": {
        "symptom": {"type": "object", "required": ["basis", "sources"], "properties": {
            "basis": {"type": "string", "enum": ["fact", "inference", "unknown"]},
            "sources": _EVIDENCE_REFS}},
        "validation": _EVIDENCE_REFS,
        "impact": _EVIDENCE_REFS,
        "prevention": {"type": "object", "required": ["implemented", "suggestions"], "properties": {
            "implemented": _EVIDENCE_REFS,
            "suggestions": {"type": "array", "items": {"type": "string"}}}},
    },
}

def validate_bug_review_document(data: dict[str, Any]) -> tuple[bool, list[str]]:
    """
    简单校验 LLM 输出是否符合 BugReviewDocument 结构
    返回 (is_valid, errors)
    """
    errors: list[str] = []
    required = ["title", "root_cause", "impact", "fix_solution", "prevention"]
    for field_name in required:
        if not data.get(field_name):
            errors.append(f"缺少必填字段: {field_name}")

    root_cause = data.get("root_cause", {})
    if isinstance(root_cause, dict):
        if not root_cause.get("content"):
            errors.append("root_cause.content 不能为空")
        source = root_cause.get("source", {})
        if isinstance(source, dict):
            if not source.get("snippet") and data.get("completeness") != "incomplete":
                errors.append("root_cause.source.snippet 不能为空（需引用原始文本）")
        else:
            errors.append("root_cause.source 格式错误")
    else:
        errors.append("root_cause 格式错误")

    impact = data.get("impact", {})
    if isinstance(impact, dict):
        if impact.get("severity") not in ("P0", "P1", "P2", "P3", "unknown"):
            errors.append("impact.severity 必须为 P0/P1/P2/P3/unknown")
    else:
        errors.append("impact 格式错误")

    return len(errors) == 0, errors


def parse_llm_bug_review(raw_text: str) -> tuple[BugReviewDocument | None, list[str]]:
    """
    解析 LLM 输出的 Bug 复盘 JSON，返回 (document, errors)
    """
    # 尝试提取 JSON 块
    import re
    json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
    if json_match:
        raw_text = json_match.group(1)
    else:
        # 尝试找到第一个 { ... } 块
        brace_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if brace_match:
            raw_text = brace_match.group(0)

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return None, [f"JSON 解析失败: {exc}"]

    is_valid, errors = validate_bug_review_document(data)
    if not is_valid:
        return None, errors

    try:
        doc = BugReviewDocument.from_dict(data)
        return doc, []
    except Exception as exc:  # noqa: BLE001
        return None, [f"数据结构化失败: {exc}"]
