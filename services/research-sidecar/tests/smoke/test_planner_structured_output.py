import pytest

from deepresearch_agent.agents.multi_agent.planner.clarifier import Clarifier
from deepresearch_agent.agents.multi_agent.planner.plan_reviewer import PlanReviewer
from deepresearch_agent.agents.multi_agent.planner.task_decomposer import TaskDecomposer


class RecordingLLM:
    def __init__(self):
        self.bind_kwargs = None

    def bind(self, **kwargs):
        self.bind_kwargs = kwargs
        return self

    def invoke(self, _prompt):
        return type("Message", (), {"content": "{}"})()


@pytest.mark.parametrize("planner_type", [Clarifier, TaskDecomposer, PlanReviewer])
def test_planner_structured_calls_disable_thinking(planner_type):
    llm = RecordingLLM()
    planner = object.__new__(planner_type)
    planner._llm = llm

    assert planner._invoke_llm("prompt") == "{}"
    assert llm.bind_kwargs == {
        "response_format": {"type": "json_object"},
        "extra_body": {"enable_thinking": False},
    }
