import type {
  BugCase,
  BugCaseDraft,
  BugCaseListFilters,
  BugCasePatch,
  BugKnowledgeApi,
  BugProject,
  BugSearchRequest,
  BugSearchResponse
} from './types';

interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: string;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok ? fallback : text || fallback);
  }
}

function errorMessage(payload: ApiErrorPayload, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string) {
  const response = await fetch(url, init);
  const data = await readJson<T & ApiErrorPayload>(response, fallback);
  if (!response.ok) throw new Error(errorMessage(data, fallback));
  return data;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function bugCaseQuery(filters: BugCaseListFilters = {}) {
  const query = new URLSearchParams();
  if (filters.sourceProjectRef) query.set('sourceProjectRef', filters.sourceProjectRef);
  if (filters.scope) query.set('scope', filters.scope);
  if (filters.reviewStatuses?.length) query.set('reviewStatus', filters.reviewStatuses.join(','));
  if (filters.statuses?.length) query.set('status', filters.statuses.join(','));
  if (filters.knowledgeBaseIds?.length) {
    query.set('knowledgeBaseId', filters.knowledgeBaseIds.join(','));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

/**
 * Bug API 是纯 HTTP 边界：不导入 Pinia，也不在失败前修改任何前端状态。
 * Store 只有在这些 Promise 成功返回服务端权威 DTO 后才替换本地快照。
 */
export const bugKnowledgeApi: BugKnowledgeApi = {
  async fetchProjects() {
    const data = await requestJson<{ projects?: BugProject[] }>(
      '/api/bug-projects',
      undefined,
      '加载 Bug 项目失败'
    );
    return data.projects || [];
  },

  async createProject(input) {
    const data = await requestJson<{ project?: BugProject }>(
      '/api/bug-projects',
      jsonRequest('POST', input),
      '创建 Bug 项目失败'
    );
    if (!data.project) throw new Error('创建 Bug 项目失败：响应缺少 project');
    return data.project;
  },

  async updateProject(projectRef, patch) {
    const data = await requestJson<{ project?: BugProject }>(
      `/api/bug-projects/${encodeURIComponent(projectRef)}`,
      jsonRequest('PATCH', patch),
      '更新 Bug 项目失败'
    );
    if (!data.project) throw new Error('更新 Bug 项目失败：响应缺少 project');
    return data.project;
  },

  async fetchCases(filters) {
    const data = await requestJson<{ bugCases?: BugCase[] }>(
      `/api/bug-cases${bugCaseQuery(filters)}`,
      undefined,
      '加载 BugCase 失败'
    );
    return data.bugCases || [];
  },

  async createCase(input: BugCaseDraft) {
    const data = await requestJson<{ bugCase?: BugCase }>(
      '/api/bug-cases',
      jsonRequest('POST', input),
      '创建 BugCase 失败'
    );
    if (!data.bugCase) throw new Error('创建 BugCase 失败：响应缺少 bugCase');
    return data.bugCase;
  },

  async updateCase(id: string, patch: BugCasePatch) {
    const data = await requestJson<{ bugCase?: BugCase }>(
      `/api/bug-cases/${encodeURIComponent(id)}`,
      jsonRequest('PATCH', patch),
      '更新 BugCase 失败'
    );
    if (!data.bugCase) throw new Error('更新 BugCase 失败：响应缺少 bugCase');
    return data.bugCase;
  },

  async deleteCase(id: string) {
    await requestJson(
      `/api/bug-cases/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      '删除 BugCase 失败'
    );
  },

  async reviewCase(id, review) {
    const data = await requestJson<{ bugCase?: BugCase }>(
      `/api/bug-cases/${encodeURIComponent(id)}/review`,
      jsonRequest('POST', review),
      '审核 BugCase 失败'
    );
    if (!data.bugCase) throw new Error('审核 BugCase 失败：响应缺少 bugCase');
    return data.bugCase;
  },

  async promoteCase(id) {
    const data = await requestJson<{ bugCase?: BugCase }>(
      `/api/bug-cases/${encodeURIComponent(id)}/promote`,
      { method: 'POST' },
      '提升公共 BugCase 失败'
    );
    if (!data.bugCase) throw new Error('提升公共 BugCase 失败：响应缺少 bugCase');
    return data.bugCase;
  },

  async searchCases(input: BugSearchRequest) {
    return requestJson<BugSearchResponse>(
      '/api/bug-cases/search',
      jsonRequest('POST', input),
      '检索 BugCase 失败'
    );
  }
};
