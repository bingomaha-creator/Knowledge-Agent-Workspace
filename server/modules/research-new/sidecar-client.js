import { createResearchNewError } from './domain.js';

function sidecarError(code, message, status, retryable = false, details = '') {
  const error = createResearchNewError(code, message, status, details);
  error.retryable = retryable;
  return error;
}

export function createResearchSidecarClient({
  baseUrl = 'http://127.0.0.1:8000/api/v1',
  timeoutMs = 15_000,
  fetcher = globalThis.fetch
} = {}) {
  const root = String(baseUrl).replace(/\/$/, '');

  async function request(path, { signal, ...options } = {}) {
    const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 15_000));
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetcher(`${root}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (timeout.aborted || error?.name === 'TimeoutError') {
        throw sidecarError('RESEARCH_SIDECAR_TIMEOUT', 'Research Sidecar 请求超时', 504, true);
      }
      throw sidecarError(
        'RESEARCH_SIDECAR_UNAVAILABLE',
        `Research Sidecar 不可用：${error?.message || error}`,
        503,
        true
      );
    }

    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const remote = payload?.error;
      throw sidecarError(
        remote?.code || 'RESEARCH_SIDECAR_REQUEST_FAILED',
        remote?.message || `Research Sidecar 请求失败（HTTP ${response.status}）`,
        response.status,
        Boolean(remote?.retryable || response.status >= 500),
        remote?.details || ''
      );
    }
    return payload;
  }

  return {
    async startRun({ question, mode, clientMessageId, retrievalBackend = 'workspace', signal }) {
      const session = await request('/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: question.slice(0, 200) }),
        signal
      });
      const accepted = await request(`/sessions/${encodeURIComponent(session.session_id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          client_message_id: clientMessageId,
          content: question,
          source_mode: mode === 'web' ? 'web' : 'graphrag',
          workflow_mode: 'deep_research',
          report_type: 'brief',
          workspace_run_id: mode === 'hybrid' ? clientMessageId : null,
          retrieval_backend: retrievalBackend
        }),
        signal
      });
      return { sessionId: session.session_id, runId: accepted.run_id, accepted };
    },
    getRun: (runId, signal) => request(`/runs/${encodeURIComponent(runId)}`, { signal }),
    getEvidence: (runId, signal) => request(`/runs/${encodeURIComponent(runId)}/evidence`, { signal }),
    getReport: (runId, signal) => request(`/runs/${encodeURIComponent(runId)}/report`, { signal }),
    cancelRun: (runId, signal) => request(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST', signal
    })
  };
}
