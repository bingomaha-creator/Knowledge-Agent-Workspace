const GITHUB_SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';

function compactSubject(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}+.#_-]/gu, ' ')
    .trim()
    .slice(0, 80);
}

function safeRepository(item, index) {
  if (!item || typeof item !== 'object') return null;
  const fullName = String(item.full_name || '').trim();
  const description = String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  let url;
  try {
    url = new URL(String(item.html_url || ''));
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname.split('/').filter(Boolean).length !== 2 ||
    !fullName
  ) {
    return null;
  }
  return {
    id: `github-repository-${fullName}`,
    title: `GitHub - ${fullName}`,
    url: url.toString(),
    snippet: description || `${fullName} GitHub repository.`,
    source: 'web',
    sourceKind: 'official_repo',
    sourceDomain: 'github.com',
    discoveryMethod: 'github_repository_search',
    providerRank: index + 1,
    repositoryStars: Number(item.stargazers_count || 0)
  };
}

/**
 * 对“官方仓库”需求使用 GitHub 自身的仓库索引作补充。请求主机与路径固定，
 * 只把实体名放进 q 参数；它不会执行仓库代码，也不会读取任意 URL。
 */
export function createResearchRepositoryResolver({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  logger = console
} = {}) {
  async function resolveRepositories({ subject, signal, limit = 2 }) {
    const entity = compactSubject(subject);
    if (!entity) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const url = new URL(GITHUB_SEARCH_ENDPOINT);
      url.searchParams.set('q', `${entity} in:name`);
      url.searchParams.set('sort', 'stars');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', String(Math.max(1, Math.min(3, limit))));
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: combinedSignal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'matthews-workspace-research-resolver',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!response.ok) return [];
      const payload = await response.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return items
        .map(safeRepository)
        .filter(Boolean)
        .slice(0, Math.max(1, Math.min(3, limit)));
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn?.(`[research] repository resolver degraded: ${error?.message || error}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  return { resolveRepositories };
}
