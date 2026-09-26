import pytest
import httpx
from deepresearch_agent.retrieval.workspace_provider import WorkspaceProvider
from deepresearch_agent.retrieval.base import SearchFilters, ToolCallContext
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalMetadata, RetrievalResult


@pytest.mark.asyncio
async def test_workspace_provider_preserves_host_scope_and_document_identity(monkeypatch):
    original = httpx.AsyncClient
    def handler(request):
        assert request.url.path == '/api/research-new/research-new-test/retrieval'
        return httpx.Response(200, json={'evidence': [{'id': 'chunk-a', 'title': 'A', 'snippet': 'original passage',
            'knowledgeBaseId': 'kb-a', 'documentId': 'doc-a'}], 'trace': {'embedding': {'ok': True}}})
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = await WorkspaceProvider('research-new-test', 'workspace').search('query', top_k=3,
        search_depth='basic', filters=SearchFilters(), call_context=ToolCallContext('r', SourceMode.GRAPHRAG))
    assert result[0].evidence == 'original passage'
    assert result[0].metadata.extra['document_id'] == 'doc-a'
    assert result[0].metadata.extra['knowledge_base_id'] == 'kb-a'
    assert result[0].metadata.extra['retrieval']['embedding']['ok'] is True


@pytest.mark.asyncio
async def test_graph_result_outside_snapshot_is_rejected(monkeypatch):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json={'graph': {
            'knowledgeBaseId': 'kb-a', 'documents': [{'fileName': 'a.md', 'name': 'A', 'documentId': 'doc-a', 'contentHash': 'h'}]}})), **kwargs))
    class Graph:
        async def search(self, *args, **kwargs):
            return [RetrievalResult(granularity='Chunk', evidence='foreign content', source='hybrid_search',
                metadata=RetrievalMetadata(source_id='x', source_type='chunk', extra={'document_id': 'foreign.md'}))]
    with pytest.raises(ValueError, match='OUTSIDE_KNOWLEDGE_SCOPE'):
        await WorkspaceProvider('research-new-test', 'graphrag', Graph()).search('query', top_k=3,
            search_depth='basic', filters=SearchFilters(), call_context=ToolCallContext('r', SourceMode.GRAPHRAG))
