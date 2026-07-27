import type {
  BugEvidenceInput,
  BugInvestigation,
  BugInvestigationApi
} from './investigation-types';

interface ErrorPayload {
  error?: string;
  details?: string;
}

async function requestInvestigation(
  url: string,
  init: RequestInit | undefined,
  fallback: string
) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: ({ investigation?: BugInvestigation } & ErrorPayload) = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(response.ok ? fallback : text);
    }
  }
  if (!response.ok) {
    throw new Error([
      payload.error || fallback,
      payload.details
    ].filter(Boolean).join('\n'));
  }
  if (!payload.investigation) throw new Error(`${fallback}：响应缺少 investigation`);
  return payload.investigation;
}

function postJson(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

export const bugInvestigationApi: BugInvestigationApi = {
  async fetchInvestigations(projectRef) {
    const response = await fetch(
      `/api/bug-investigations?projectRef=${encodeURIComponent(projectRef)}`
    );
    const payload = await response.json() as {
      investigations?: BugInvestigation[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || '加载 Bug 调查失败');
    return payload.investigations || [];
  },

  createInvestigation(input) {
    return requestInvestigation(
      '/api/bug-investigations',
      postJson(input),
      '创建 Bug 调查失败'
    );
  },

  appendEvidence(id: string, input: BugEvidenceInput) {
    return requestInvestigation(
      `/api/bug-investigations/${encodeURIComponent(id)}/evidence`,
      postJson(input),
      '追加调查证据失败'
    );
  },

  analyzeInvestigation(id) {
    return requestInvestigation(
      `/api/bug-investigations/${encodeURIComponent(id)}/analyze`,
      postJson(),
      '分析 Bug 证据失败'
    );
  },

  convertToCandidate(id) {
    return requestInvestigation(
      `/api/bug-investigations/${encodeURIComponent(id)}/convert`,
      postJson(),
      '转为候选 BugCase 失败'
    );
  },

  closeInvestigation(id) {
    return requestInvestigation(
      `/api/bug-investigations/${encodeURIComponent(id)}/close`,
      postJson(),
      '关闭 Bug 调查失败'
    );
  }
};
