export function createBugReviewClient({ baseUrl = process.env.BUG_REVIEW_SIDECAR_URL || 'http://127.0.0.1:8011', timeoutMs = 10000, fetchImpl = fetch } = {}) {
  return {
    async request(method, path, body) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/bug-review${path}`, {
          method,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        throw Object.assign(new Error('Bug 复盘服务不可用或响应超时，请启动 Sidecar 后重试。'), { status: 503, code: 'BUG_REVIEW_UNAVAILABLE' });
      }
      let data;
      try { data = await response.json(); }
      catch { throw Object.assign(new Error('Bug 复盘服务返回异常协议。'), { status: 502, code: 'BUG_REVIEW_PROTOCOL' }); }
      if (!response.ok) {
        throw Object.assign(new Error(typeof data.error === 'string' ? data.error : 'Bug 复盘请求失败。'), {
          status: response.status, code: typeof data.code === 'string' ? data.code : 'BUG_REVIEW_ERROR'
        });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw Object.assign(new Error('Bug 复盘服务返回异常协议。'), { status: 502, code: 'BUG_REVIEW_PROTOCOL' });
      }
      return { status: response.status, data };
    }
  };
}
