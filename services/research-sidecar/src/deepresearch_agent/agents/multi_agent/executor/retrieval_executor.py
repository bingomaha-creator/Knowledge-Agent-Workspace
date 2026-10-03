"""
检索执行器

负责解析PlanExecutionSignal中的检索类任务并调用既有搜索工具（local/global/chain等）。
"""
from typing import Any, Dict, List, Optional
import time
import logging
import uuid

from deepresearch_agent.agents.multi_agent.core.execution_record import (
    ExecutionMetadata,
    ExecutionRecord,
    ToolCall,
)
from deepresearch_agent.agents.multi_agent.core.plan_spec import (
    PlanExecutionSignal,
    TaskNode,
)
from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult
from deepresearch_agent.agents.multi_agent.core.state import PlanExecuteState
from deepresearch_agent.agents.multi_agent.executor.base_executor import (
    BaseExecutor,
    ExecutorConfig,
    TaskExecutionResult,
)
from deepresearch_agent.agents.multi_agent.tools.evidence_tracker import get_evidence_tracker
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.policies import SourcePolicy
from deepresearch_agent.harness.evidence import EvidenceLedger
from deepresearch_agent.retrieval.base import RetrievalProvider, SearchFilters, ToolCallContext, run_async_from_sync
from deepresearch_agent.retrieval.router import RetrievalRouter, create_default_router

_LOGGER = logging.getLogger(__name__)


class RetrievalExecutor(BaseExecutor):
    """
    检索任务执行器
    """

    worker_type: str = "retrieval_executor"

    def __init__(
        self,
        config: Optional[ExecutorConfig] = None,
        *,
        tool_registry: Optional[Dict[str, Any]] = None,
        extra_tool_factories: Optional[Dict[str, Any]] = None,
        provider: Optional[RetrievalProvider] = None,
        router: Optional[RetrievalRouter] = None,
        source_policy: Optional[SourcePolicy] = None,
        evidence_ledger: Optional[EvidenceLedger] = None,
    ) -> None:
        super().__init__(config)
        self._tool_registry = dict(tool_registry) if tool_registry is not None else None
        self._extra_factories = dict(extra_tool_factories) if extra_tool_factories is not None else None
        self._tool_cache: Dict[str, Any] = {}
        self._extra_cache: Dict[str, Any] = {}
        self._provider = provider
        self._router = router or (None if provider is not None else create_default_router())
        self._source_policy = source_policy or SourcePolicy()
        self._evidence_ledger = evidence_ledger or EvidenceLedger()

    def can_handle(self, task_type: str) -> bool:
        return task_type in {
            "local_search", "global_search", "hybrid_search", "naive_search",
            "web_search", "deep_research", "deeper_research", "chain_exploration",
        }

    def execute_task(
        self,
        task: TaskNode,
        state: PlanExecuteState,
        signal: PlanExecutionSignal,
    ) -> TaskExecutionResult:
        """
        执行检索类任务，默认调用search工具的structured_search接口。
        """
        tool_name = task.task_type
        payload = self.build_default_inputs(task)
        cache_key = f"{task.task_id}:{tool_name}"

        _LOGGER.info(
            "[RetrievalExecutor] 执行任务 %s (%s) payload=%s",
            task.task_id,
            tool_name,
            payload,
        )

        provider = self._provider or self._router.for_mode(state.source_mode)  # type: ignore[union-attr]
        if provider.mode.value != state.source_mode or task.source_mode != state.source_mode:
            raise ValueError("Plan/Task/Provider source_mode 不一致")
        tool_call_id = f"call_{uuid.uuid4().hex}"
        start_time = time.perf_counter()
        success = True
        error_message: Optional[str] = None
        structured_output: Dict[str, Any] = {}

        try:
            if tool_name in {"deep_research", "deeper_research"}:
                structured_output = self._invoke_research_tool(provider, tool_name, payload, state.run_id)
            elif tool_name in {"local_search", "global_search", "hybrid_search", "naive_search", "web_search"}:
                structured_output = self._invoke_provider(
                    provider, tool_name, payload, state, task, tool_call_id
                )
            else:
                # Graph-only legacy specialist tools remain available, but are source-gated.
                self._source_policy.assert_tool_allowed(SourceMode(state.source_mode), tool_name)
                tool_instance = self._get_tool_instance(tool_name)
                structured_output = self._invoke_tool(tool_instance, tool_name, payload)
        except Exception as exc:  # noqa: BLE001
            success = False
            error_message = str(exc)
            _LOGGER.exception("检索任务执行失败 task=%s error=%s", task.task_id, exc)

        latency = time.perf_counter() - start_time
        tool_call = ToolCall(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            source_mode=state.source_mode,
            args=payload,
            result=structured_output if success else None,
            status="success" if success else "failed",
            error=error_message,
            latency_ms=round(latency * 1000, 3),
        )

        evidence = self._extract_evidence(
            state, structured_output, task_id=task.task_id,
            tool_call_id=tool_call_id, provider=provider.provider_name,
        ) if success else []

        metadata = ExecutionMetadata(
            worker_type=self.worker_type,
            latency_seconds=latency,
            tool_calls_count=1,
            evidence_count=len(evidence),
            environment={
                "execution_mode": signal.execution_mode,
                "cache_key": cache_key,
                "source_mode": state.source_mode,
                "provider": provider.provider_name,
            },
        )

        record = ExecutionRecord(
            task_id=task.task_id,
            session_id=state.session_id,
            worker_type=self.worker_type,
            inputs={
                "payload": payload,
                "task": task.model_dump(),
            },
            tool_calls=[tool_call],
            evidence=evidence,
            metadata=metadata,
        )

        self._update_state(state, task, record, success, error_message)

        return TaskExecutionResult(
            record=record,
            success=success,
            error=error_message,
        )

    def _invoke_provider(
        self,
        provider: RetrievalProvider,
        task_type: str,
        payload: Dict[str, Any],
        state: PlanExecuteState,
        task: TaskNode,
        tool_call_id: str,
    ) -> Dict[str, Any]:
        actual_tool = "tavily_search" if provider.mode == SourceMode.WEB else task_type
        self._source_policy.assert_tool_allowed(provider.mode, actual_tool)
        query = str(payload.get("query") or task.description)
        results = run_async_from_sync(lambda: provider.search(
            query,
            top_k=int(payload.get("top_k") or 5),
            search_depth=payload.get("search_depth", "advanced"),
            filters=SearchFilters(
                strategy=task_type if provider.mode == SourceMode.GRAPHRAG else None,
                include_domains=tuple(payload.get("include_domains") or ()),
                exclude_domains=tuple(payload.get("exclude_domains") or ()),
                start_date=payload.get("start_date"),
                end_date=payload.get("end_date"),
                topic=payload.get("topic"),
            ),
            call_context=ToolCallContext(
                run_id=state.run_id,
                source_mode=provider.mode,
                task_id=task.task_id,
                tool_call_id=tool_call_id,
            ),
        ))
        if any(result.source_mode != provider.mode.value for result in results):
            raise ValueError("Provider 返回了与 Run.source_mode 不一致的证据")
        return {
            "answer": "\n\n".join(str(result.evidence) for result in results),
            "retrieval_results": [result.to_dict() for result in results],
            "provider": provider.provider_name,
            "source_mode": provider.mode.value,
        }

    def _invoke_research_tool(
        self,
        provider: RetrievalProvider,
        task_type: str,
        payload: Dict[str, Any],
        run_id: str,
    ) -> Dict[str, Any]:
        from deepresearch_agent.search.tool.deep_research_tool import DeepResearchTool

        if task_type == "deeper_research" and provider.mode == SourceMode.GRAPHRAG:
            from deepresearch_agent.search.tool.deeper_research_tool import DeeperResearchTool
            tool = DeeperResearchTool(provider=provider, run_id=run_id)
        else:
            tool = DeepResearchTool(provider=provider, run_id=run_id)
        raw = tool.search(payload)
        provider_results = getattr(tool, "provider_results", None)
        if provider_results is None and hasattr(tool, "deep_research"):
            provider_results = getattr(tool.deep_research, "provider_results", [])
        return {
            "answer": raw if isinstance(raw, str) else raw.get("answer", str(raw)),
            "raw_result": raw,
            "retrieval_results": [result.to_dict() for result in (provider_results or [])],
            "provider": provider.provider_name,
            "source_mode": provider.mode.value,
        }

    def _get_tool_instance(self, task_type: str) -> Any:
        if self._tool_registry is None or self._extra_factories is None:
            from deepresearch_agent.search.tool_registry import TOOL_REGISTRY, EXTRA_TOOL_FACTORIES
            if self._tool_registry is None:
                self._tool_registry = dict(TOOL_REGISTRY)
            if self._extra_factories is None:
                self._extra_factories = dict(EXTRA_TOOL_FACTORIES)
        if task_type in self._tool_registry:
            if task_type not in self._tool_cache:
                self._tool_cache[task_type] = self._tool_registry[task_type]()
            return self._tool_cache[task_type]
        if task_type in self._extra_factories:
            if task_type not in self._extra_cache:
                factory = self._extra_factories[task_type]
                self._extra_cache[task_type] = factory()
            return self._extra_cache[task_type]
        raise KeyError(f"未找到任务类型 {task_type} 对应的检索工具")

    def _invoke_tool(self, tool: Any, task_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        调用具体的检索工具。

        优先使用structured_search，其次使用search，特殊工具（如chain_exploration）调用自定义方法。
        """
        if hasattr(tool, "structured_search"):
            return tool.structured_search(payload)
        if hasattr(tool, "search"):
            result = tool.search(payload)
            if isinstance(result, dict):
                return result
            return {"answer": result, "retrieval_results": []}
        if task_type == "chain_exploration" and hasattr(tool, "explore"):
            query = payload.get("query")
            start_entities = payload.get("start_entities") or payload.get("entities")
            max_steps = payload.get("max_steps")
            exploration_width = payload.get("exploration_width")
            return tool.explore(
                query=query,
                start_entities=start_entities,
                max_steps=max_steps,
                exploration_width=exploration_width,
            )
        raise ValueError(f"任务类型 {task_type} 未提供可用的执行方法")

    def _extract_evidence(
        self,
        state: PlanExecuteState,
        output: Dict[str, Any],
        *,
        task_id: str,
        tool_call_id: str,
        provider: str,
    ) -> List[RetrievalResult]:
        results_payload = output.get("retrieval_results") if isinstance(output, dict) else None
        evidence: List[RetrievalResult] = []
        if not isinstance(results_payload, list):
            return evidence

        for item in results_payload:
            try:
                if isinstance(item, RetrievalResult):
                    evidence.append(item)
                elif isinstance(item, dict):
                    evidence.append(RetrievalResult.from_dict(item))
            except Exception as exc:  # noqa: BLE001
                _LOGGER.warning("无法解析retrieval_result: %s error=%s", item, exc)
        if not evidence:
            return evidence
        assigned = self._evidence_ledger.assign(
            run_id=state.run_id,
            task_id=task_id,
            tool_call_id=tool_call_id,
            provider=provider,
            results=evidence,
        )
        evidence = [result for result, _ in assigned]
        try:
            tracker = get_evidence_tracker(state)
            return tracker.register(evidence)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("证据追踪失败，使用原始结果: %s", exc)
            return evidence

    def _update_state(
        self,
        state: PlanExecuteState,
        task: TaskNode,
        record: ExecutionRecord,
        success: bool,
        error: Optional[str],
    ) -> None:
        """
        将执行结果写回PlanExecuteState，更新任务状态、上下文与记录。
        """
        exec_context = state.execution_context
        if exec_context is None:
            return

        exec_context.current_task_id = task.task_id
        exec_context.tool_call_history.append(
            {
                "task_id": task.task_id,
                "tool_name": record.tool_calls[0].tool_name if record.tool_calls else "",
                "status": record.tool_calls[0].status if record.tool_calls else "unknown",
                "latency_ms": record.metadata.latency_seconds * 1000,
            }
        )

        if success:
            if task.task_id not in exec_context.completed_task_ids:
                exec_context.completed_task_ids.append(task.task_id)
            exec_context.retrieval_cache[task.task_id] = [res.to_dict() for res in record.evidence]
            tool_result_payload: Dict[str, Any] = {}
            if record.tool_calls and isinstance(record.tool_calls[0].result, dict):
                tool_result_payload = record.tool_calls[0].result  # type: ignore[assignment]
            answer_text = self._extract_answer_text(tool_result_payload, record)
            exec_context.intermediate_results[task.task_id] = {
                "answer": answer_text,
                "raw_result": tool_result_payload,
                "metadata": record.metadata.model_dump(),
            }
        else:
            exec_context.errors.append(
                {
                    "task_id": task.task_id,
                    "error": error,
                    "worker_type": self.worker_type,
                }
            )

        state.execution_records.append(record)

        if state.plan is not None:
            state.plan.update_task_status(task.task_id, "completed" if success else "failed")

    @staticmethod
    def _extract_from_dict(payload: Dict[str, Any]) -> Optional[str]:
        """
        从结构化Payload中提取可能的回答文本。
        """
        candidate_keys = (
            "answer",
            "final_answer",
            "final_report",
            "response",
            "summary",
            "output",
        )
        for key in candidate_keys:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        report_block = payload.get("report")
        if isinstance(report_block, dict):
            report_answer = report_block.get("final_report") or report_block.get("summary")
            if isinstance(report_answer, str) and report_answer.strip():
                return report_answer.strip()
        return None

    def _extract_answer_text(
        self,
        payload: Dict[str, Any],
        record: ExecutionRecord,
    ) -> Optional[str]:
        """
        综合多源数据提取用于后续反思的答案文本。
        """
        if payload:
            candidate = self._extract_from_dict(payload)
            if candidate:
                return candidate

        for call in record.tool_calls:
            result = call.result
            if isinstance(result, dict):
                candidate = self._extract_from_dict(result)
                if candidate:
                    return candidate
            elif isinstance(result, str) and result.strip():
                return result.strip()

        return None
