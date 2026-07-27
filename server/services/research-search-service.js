function createServiceError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

export function normalizeKnowledgeBaseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim().slice(0, 160))
  )].slice(0, 20);
}

export function createResearchSearchService({
  searchEvidence,
  toolExecutor,
  logger = console
}) {
  async function searchSources({
    query,
    knowledgeBaseIds = [],
    searchMode = 'local',
    signal
  }) {
    if (signal?.aborted) {
      throw createServiceError('RESEARCH_CANCELLED', '研究任务已取消', '', 499);
    }

    const scope = normalizeKnowledgeBaseIds(knowledgeBaseIds);
    const localSearch = searchEvidence({
      query: String(query || '').slice(0, 4000),
      knowledgeBaseIds: scope,
      limit: 6,
      signal
    });

    if (searchMode === 'local') {
      const { evidence: local } = await localSearch;
      return { local, web: [], webSearchStatus: 'not_requested' };
    }

    // 本地检索和联网检索互不依赖，同时启动可避免每个子问题多付一段串行等待。
    // 联网失败仍安全降级；本地检索失败则保留原有的失败语义。
    const webSearch = toolExecutor.callTool(
      'search_web',
      { query: String(query || '').slice(0, 500), topK: 6 },
      { caller: 'research', invocation: 'orchestrated' },
      { signal, timeout: 12_000 }
    ).then((result) => {
      const structured = result.structured;
      return {
        web: Array.isArray(structured.results) ? structured.results : [],
        webSearchStatus: structured.available === false
          ? 'unavailable'
          : structured.status === 'success'
            ? 'available'
            : 'error'
      };
    }).catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      logger.error?.(
        `[research] controlled web search failed: ${error?.message || error}`
      );
      return { web: [], webSearchStatus: 'error' };
    });

    const [{ evidence: local }, webResult] = await Promise.all([localSearch, webSearch]);
    return { local, ...webResult };
  }

  return { searchSources };
}
