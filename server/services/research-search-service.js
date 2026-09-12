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
  /**
   * Web SearchProvider 调用边界（Spec research-harness §9.1）：仅在真正发起
   * search_web 请求时通知 onWebSearchAttempt——local 模式不发起、未来若引入
   * 缓存则缓存命中也不应发起，因此观察者必须放在 callTool 之前这一固定位置。
   * onWebSearchAttempt 是同步观察者（synchronous observer）：在 Provider 请求
   * 发起的同一调用栈内被同步调用，仅用于计数/诊断；不支持也不需要异步观察者、
   * 事件总线。观察者失败不得影响检索。
   */
  function initiateWebSearch({ query, searchMode, onWebSearchAttempt, signal }) {
    if (typeof onWebSearchAttempt === 'function') {
      try {
        onWebSearchAttempt({ query: String(query || '').slice(0, 500), searchMode });
      } catch { /* 观察者异常由调用方自身诊断 */ }
    }

    return toolExecutor.callTool(
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
  }

  async function searchSources({
    query,
    knowledgeBaseIds = [],
    searchMode = 'local',
    onWebSearchAttempt,
    signal
  }) {
    if (signal?.aborted) {
      throw createServiceError('RESEARCH_CANCELLED', '研究任务已取消', '', 499);
    }

    const scope = normalizeKnowledgeBaseIds(knowledgeBaseIds);

    // 检索模式语义（Spec research-harness §6.1，Phase 2A 修复项）：
    // - local：只检索本地资料，不发起 Web Provider 调用；
    // - web：只发起 Web Provider 调用，不启动、不返回本地检索（修复历史偏差：
    //   此前 web 模式也会启动并返回本地结果）；
    // - hybrid：本地与联网真实并行（两条检索同时启动），结果各自保留来源类别。
    if (searchMode === 'local') {
      const { evidence: local } = await searchEvidence({
        query: String(query || '').slice(0, 4000),
        knowledgeBaseIds: scope,
        limit: 6,
        signal
      });
      return { local, web: [], webSearchStatus: 'not_requested' };
    }

    // 联网失败仍安全降级；本地检索失败则保留原有的失败语义。
    const localSearch = searchMode === 'hybrid'
      ? searchEvidence({
        query: String(query || '').slice(0, 4000),
        knowledgeBaseIds: scope,
        limit: 6,
        signal
      })
      : null;
    const webSearch = initiateWebSearch({ query, searchMode, onWebSearchAttempt, signal });

    if (searchMode === 'web') {
      const webResult = await webSearch;
      return { local: [], web: webResult.web, webSearchStatus: webResult.webSearchStatus };
    }

    const [{ evidence: local }, webResult] = await Promise.all([localSearch, webSearch]);
    return { local, web: webResult.web, webSearchStatus: webResult.webSearchStatus };
  }

  return { searchSources };
}
