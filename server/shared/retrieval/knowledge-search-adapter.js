function normalizeEvidence(citation) {
  const headingPath = Array.isArray(citation?.headingPath) ? citation.headingPath : [];
  const retrieval = citation?.retrieval && typeof citation.retrieval === 'object'
    ? citation.retrieval
    : undefined;
  const normalized = {
    id: String(citation?.id || ''),
    title: [citation?.title, ...headingPath].filter(Boolean).join(' / '),
    snippet: String(citation?.snippet || '').slice(0, 800),
    source: '本地知识库',
    knowledgeBaseId: String(citation?.knowledgeBaseId || 'kb-default'),
    documentId: String(citation?.documentId || ''),
    sourceKind: 'project_knowledge'
  };
  if (Number.isFinite(Number(citation?.score))) normalized.score = Number(citation.score);
  if (retrieval) normalized.retrieval = retrieval;
  return normalized;
}

export function createMcpKnowledgeSearchAdapter({ toolExecutor }) {
  return {
    async searchEvidence({ query, knowledgeBaseIds = [], limit = 6, signal }) {
      const result = await toolExecutor.callToolOrThrow(
        'retrieve_knowledge',
        {
          query: String(query || '').slice(0, 4000),
          topK: Math.max(1, Math.min(10, Number(limit) || 6)),
          knowledgeBaseIds
        },
        { caller: 'research', invocation: 'orchestrated' },
        { signal }
      );
      const citations = Array.isArray(result.structured?.citations)
        ? result.structured.citations
        : [];
      return {
        evidence: citations.map(normalizeEvidence),
        trace: result.structured?.trace || null
      };
    }
  };
}
