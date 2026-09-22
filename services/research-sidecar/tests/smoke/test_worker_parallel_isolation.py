import threading

from deepresearch_agent.agents.multi_agent.core.execution_record import ExecutionMetadata, ExecutionRecord
from deepresearch_agent.agents.multi_agent.core.plan_spec import AcceptanceCriteria, PlanSpec, ProblemStatement, TaskGraph, TaskNode
from deepresearch_agent.agents.multi_agent.core.state import PlanExecuteState
from deepresearch_agent.agents.multi_agent.executor.base_executor import BaseExecutor, TaskExecutionResult
from deepresearch_agent.agents.multi_agent.executor.worker_coordinator import WorkerCoordinator


class IsolatedExecutor(BaseExecutor):
    worker_type = "isolation_test"

    def __init__(self, barrier):
        super().__init__()
        self.barrier = barrier

    def can_handle(self, task_type: str) -> bool:
        return task_type == "custom"

    def execute_task(self, task, state, signal):
        self.barrier.wait(timeout=5)
        record = ExecutionRecord(task_id=task.task_id, session_id=state.session_id, worker_type=self.worker_type, metadata=ExecutionMetadata(worker_type=self.worker_type))
        state.execution_records.append(record)
        state.execution_context.completed_task_ids.append(task.task_id)
        state.execution_context.intermediate_results[task.task_id] = task.description
        state.plan.update_task_status(task.task_id, "completed")
        return TaskExecutionResult(record=record, success=True)


def test_parallel_workers_merge_local_state_once_in_plan_order():
    tasks = [TaskNode(task_id=f"task_{index}", task_type="custom", description=str(index)) for index in range(4)]
    plan = PlanSpec(problem_statement=ProblemStatement(original_query="parallel"), task_graph=TaskGraph(nodes=tasks, execution_mode="parallel"), acceptance_criteria=AcceptanceCriteria())
    state = PlanExecuteState(input="parallel", plan=plan)
    coordinator = WorkerCoordinator(executors=[IsolatedExecutor(threading.Barrier(4))], execution_mode="parallel", max_parallel_workers=4)

    progress = []
    lock = threading.Lock()

    def on_progress(kind, task, record):
        with lock:
            progress.append((kind, task.task_id, None if record is None else record.record_id))

    records = coordinator.execute_plan(state, plan.to_execution_signal(), progress_callback=on_progress)

    assert [record.task_id for record in records] == [f"task_{index}" for index in range(4)]
    assert [record.task_id for record in state.execution_records] == [f"task_{index}" for index in range(4)]
    assert state.execution_context.completed_task_ids == [f"task_{index}" for index in range(4)]
    assert len({record.record_id for record in state.execution_records}) == 4
    assert all(node.status == "completed" for node in state.plan.task_graph.nodes)
    assert {task_id for kind, task_id, _ in progress if kind == "task.started"} == {f"task_{index}" for index in range(4)}
    assert {task_id for kind, task_id, record_id in progress if kind == "task.completed" and record_id} == {f"task_{index}" for index in range(4)}
