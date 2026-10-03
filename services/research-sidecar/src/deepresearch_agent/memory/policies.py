"""Safety policy for durable semantic memory."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MemoryPolicyVerdict:
    allowed: bool
    reason: str | None = None


class MemoryPolicy:
    _blocked = (
        (re.compile(r"\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b", re.I), "疑似 API Key"),
        (re.compile(r"\b(?:api[_ -]?key|access[_ -]?token|bearer)\s*[:=]\s*\S+", re.I), "疑似访问凭据"),
        (re.compile(r"(?:[A-Za-z]:\\(?:Users|Windows)\\|/(?:home|etc|root)/)", re.I), "绝对敏感路径"),
        (re.compile(r"(?:忽略|绕过|覆盖).{0,20}(?:系统|规则|指令)|(?:泄露|输出).{0,20}(?:密钥|token)", re.I), "提示注入文本"),
        (re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]"), "不可见或双向控制字符"),
        (re.compile(r"(?:^|\n)#{1,3}\s*(?:深度研究)?报告|<think>|\*\*Final Information\*\*", re.I), "完整报告或模型推理不能作为持久 Memory"),
        (re.compile(r"\[ev_[a-f0-9]{12,}\]", re.I), "研究证据正文不能直接作为持久 Memory"),
    )

    def validate(self, content: str) -> MemoryPolicyVerdict:
        normalized = content.strip()
        if not normalized:
            return MemoryPolicyVerdict(False, "Memory 内容为空")
        if len(normalized) > 600:
            return MemoryPolicyVerdict(False, "单条 Memory 必须是简洁、原子的事实或决策（不超过 600 字符）")
        for pattern, reason in self._blocked:
            if pattern.search(normalized):
                return MemoryPolicyVerdict(False, reason)
        return MemoryPolicyVerdict(True)
