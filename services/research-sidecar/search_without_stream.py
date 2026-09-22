import argparse
import asyncio
import sys
import time
from datetime import datetime
from pathlib import Path

# src 布局：脚本从项目根目录直接运行时，将 src 加入 sys.path 以定位 deepresearch_agent 包
_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from deepresearch_agent.agents.deep_research_agent import DeepResearchAgent
from deepresearch_agent.agents.fusion_agent import FusionGraphRAGAgent
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.contracts import WorkflowMode
from deepresearch_agent.harness.bootstrap import run_persistent_query
from deepresearch_agent.retrieval.router import create_default_router


AGENT_NAMES = ("deep_research", "fusion")


def run_query(agent_name: str, query: str, thread_id: str, source_mode: SourceMode) -> None:
    provider = create_default_router().for_mode(source_mode)
    if agent_name == "deep_research":
        agent = DeepResearchAgent(use_deeper_tool=True, retrieval_provider=provider)
    else:
        agent = FusionGraphRAGAgent(retrieval_provider=provider, source_mode=source_mode)
    try:
        start_time = time.time()
        answer = agent.ask(query, thread_id=thread_id)
        elapsed = time.time() - start_time
        print(f"\n[{agent_name}] finished in {elapsed:.2f}s")
        print(answer)
    finally:
        if hasattr(agent, "close"):
            agent.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run an existing GraphRAG agent smoke query")
    parser.add_argument("query", nargs="?", default="急性脑⾎管病吃什么药？写一份研究报告")
    parser.add_argument("--agent", choices=AGENT_NAMES, default="deep_research")
    parser.add_argument("--source-mode", choices=[mode.value for mode in SourceMode], default=SourceMode.GRAPHRAG.value)
    parser.add_argument("--thread-id", default=None)
    parser.add_argument("--legacy", action="store_true", help="Use the pre-Harness compatibility entry point")
    args = parser.parse_args()
    agent_name = args.agent
    query = args.query
    thread_id = args.thread_id or f"{agent_name}_{int(time.time())}"
    print(f"Started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if args.legacy:
        run_query(agent_name, query, thread_id, SourceMode(args.source_mode))
        return
    workflow = WorkflowMode.DEEP_RESEARCH if agent_name == "deep_research" else WorkflowMode.PLAN_EXECUTE_REPORT
    result = asyncio.run(run_persistent_query(query, source_mode=SourceMode(args.source_mode), workflow_mode=workflow, client_message_id=thread_id))
    print(f"\n[Harness] run_id={result.run_id} status={result.status}")
    print(result.report or "未生成报告")


if __name__ == "__main__":
    main()
