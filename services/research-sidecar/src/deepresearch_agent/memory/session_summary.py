"""Compatibility import; compaction belongs to context engineering."""

from deepresearch_agent.context.compactor import ContextCompactor


class SessionSummarizer(ContextCompactor):
    """Legacy constructor mapped onto token-pressure compaction."""

    def __init__(self, sessions, messages, *, threshold_messages: int = 20):
        super().__init__(
            sessions, messages,
            threshold_tokens=max(100, threshold_messages * 10),
            protect_recent_messages=max(2, threshold_messages // 2),
        )

__all__ = ["ContextCompactor", "SessionSummarizer"]
