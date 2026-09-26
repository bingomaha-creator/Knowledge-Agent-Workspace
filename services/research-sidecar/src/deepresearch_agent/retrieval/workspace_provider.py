"""Use the host project's published Knowledge scope inside the unchanged research workflow."""
import hashlib
import os
from urllib.parse import quote
import httpx

from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalMetadata, RetrievalResult
from deepresearch_agent.harness.contracts import SourceMode


class WorkspaceProvider:
    # Upstream calls its private-source mode graphrag; the actual backend stays explicit.
    mode = SourceMode.GRAPHRAG

    def __init__(self, run_id, backend, graph_provider=None):
        self.run_id = run_id
        self.provider_name = backend
        self.graph_provider = graph_provider
        self.base_url = os.getenv("RESEARCH_NODE_URL", "http://127.0.0.1:8787").rstrip("/")

    async def search(self, query, *, top_k, search_depth, filters, call_context):
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.post(
                f"{self.base_url}/api/research-new/{quote(self.run_id, safe='')}/retrieval",
                json={"query": query, "topK": top_k},
            )
            response.raise_for_status()
            payload = response.json()
        if self.graph_provider is not None:
            graph = payload["graph"]
            documents = {doc["fileName"]: doc for doc in graph["documents"]}
            results = await self.graph_provider.search(query, top_k=top_k,
                search_depth=search_depth, filters=filters, call_context=call_context)
            for result in results:
                key = result.metadata.extra.get("document_id") or result.metadata.title
                doc = documents.get(key)
                if doc is None:
                    raise ValueError("GRAPH_EVIDENCE_OUTSIDE_KNOWLEDGE_SCOPE")
                result.metadata.title = doc["name"]
                result.metadata.extra.update(document_id=doc["documentId"],
                    knowledge_base_id=graph["knowledgeBaseId"], graph_content_hash=doc["contentHash"])
            return results
        results = []
        for item in payload.get("evidence", []):
            passage = item["snippet"]
            results.append(RetrievalResult(
                result_id=item["id"], granularity="Chunk", evidence=passage, source="custom",
                source_mode="graphrag", score=max(0, min(1, float(item.get("score", 0.5)))),
                metadata=RetrievalMetadata(source_id=item["id"], source_type="chunk",
                    title=item["title"], content_hash=hashlib.sha256(passage.encode()).hexdigest(),
                    extra={"provider": "workspace", "document_id": item["documentId"],
                        "chunk_id": item["id"], "knowledge_base_id": item["knowledgeBaseId"],
                        "retrieval": payload.get("trace")})))
        return results
