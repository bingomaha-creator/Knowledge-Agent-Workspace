import { createHash } from 'node:crypto';

function sourceId(...parts) {
  return `source-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
}

function webCandidate(item, trackId, query) {
  const url = String(item?.url || '');
  return {
    id: sourceId(trackId, 'web', url || item?.id),
    trackId,
    origin: 'web',
    title: String(item?.title || '').slice(0, 500),
    url,
    snippet: String(item?.snippet || '').slice(0, 2000),
    rawContent: typeof item?.rawContent === 'string' ? item.rawContent : undefined,
    rawContentComplete: item?.rawContentComplete === true,
    query,
    sourceKind: String(item?.sourceKind || 'public_web'),
    publishedAt: String(item?.publishedAt || ''),
    providerRank: Number(item?.providerRank) || 0
  };
}

function workspaceCandidate(item, trackId, query) {
  const chunkId = String(item?.id || '');
  const knowledgeBaseId = String(item?.knowledgeBaseId || '');
  return {
    id: sourceId(trackId, 'workspace', knowledgeBaseId, item?.documentId, chunkId),
    trackId,
    origin: 'workspace',
    title: String(item?.title || '').slice(0, 500),
    snippet: String(item?.snippet || '').slice(0, 2000),
    content: String(item?.snippet || '').slice(0, 2000),
    query,
    sourceKind: 'project_knowledge',
    knowledgeBaseId,
    documentId: String(item?.documentId || ''),
    chunkId
  };
}

export function createResearchNewSearch({ knowledgeSearch, toolExecutor }) {
  if (!knowledgeSearch?.searchEvidence || !toolExecutor?.callTool) {
    throw new TypeError('Research New Search 需要 Knowledge Search 与 Tool Executor');
  }

  async function search({ trackId, query, mode, knowledgeBaseIds, signal }) {
    const normalizedQuery = String(query || '').trim().slice(0, 500);
    const webPromise = toolExecutor.callTool(
      'search_web',
      { query: normalizedQuery, topK: 6 },
      { caller: 'research', invocation: 'orchestrated' },
      { signal, timeout: 12_000 }
    );
    const workspacePromise = mode === 'hybrid'
      ? knowledgeSearch.searchEvidence({
        query: normalizedQuery,
        knowledgeBaseIds,
        limit: 6,
        signal
      })
      : Promise.resolve({ evidence: [] });

    const [webResult, workspaceResult] = await Promise.all([webPromise, workspacePromise]);
    if (signal?.aborted) throw signal.reason;
    const structured = webResult?.structured || {};
    const webStatus = structured.available === false
      ? 'unavailable'
      : structured.status === 'success'
        ? 'available'
        : 'error';
    return {
      query: normalizedQuery,
      webStatus,
      sources: [
        ...(Array.isArray(workspaceResult?.evidence) ? workspaceResult.evidence : [])
          .map((item) => workspaceCandidate(item, trackId, normalizedQuery)),
        ...(Array.isArray(structured.results) ? structured.results : [])
          .map((item) => webCandidate(item, trackId, normalizedQuery))
      ]
    };
  }

  async function buildWorkspaceContext({ question, knowledgeBaseIds, signal }) {
    const result = await knowledgeSearch.searchEvidence({
      query: String(question || '').trim().slice(0, 1000),
      knowledgeBaseIds,
      limit: 6,
      signal
    });
    return (Array.isArray(result?.evidence) ? result.evidence : []).map((item) => ({
      knowledgeBaseId: String(item.knowledgeBaseId || ''),
      documentId: String(item.documentId || ''),
      chunkId: String(item.id || ''),
      title: String(item.title || '').slice(0, 300),
      snippet: String(item.snippet || '').slice(0, 1000)
    }));
  }

  return { search, buildWorkspaceContext };
}
