/**
 * 受控联网检索 Provider。
 *
 * 它不是通用 URL 抓取器：只向运维预先配置的固定 HTTPS endpoint 发 POST，并把多种
 * 上游 JSON 归一化为有限条检索结果。安全边界包括 endpoint host 白名单、禁止 URL
 * 内嵌凭据、拒绝重定向、超时、响应体大小和字段长度限制。未配置 Key 或服务异常时
 * 返回结构化降级状态，由研究 Worker 决定继续本地检索，而不是让整个进程崩溃。
 * host 白名单属于部署配置的信任边界；本实现不负责 DNS 解析或私网 IP 识别。
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const BOCHA_WEB_SEARCH_ENDPOINT = 'https://api.bochaai.com/v1/web-search';
const BOCHA_HOST = 'api.bochaai.com';

// 查询、结果数量及每个展示字段都有硬上限，避免上游内容无限进入内存、SQLite 和 UI。
export const WEB_SEARCH_LIMITS = Object.freeze({
  maxQueryLength: 500,
  maxResults: 8,
  maxTitleLength: 300,
  maxUrlLength: 2048,
  maxSnippetLength: 2000
});

const SOURCE_KINDS = new Set([
  'official_docs',
  'official_repo',
  'paper',
  'standard',
  'public_web'
]);

// 单独的错误类型让调用层把“响应过大”与普通网络失败区分为可诊断状态。
class ResponseTooLargeError extends Error {
  constructor() {
    super('联网检索服务返回的内容超过了安全限制。');
    this.name = 'ResponseTooLargeError';
  }
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function getEnvValue(env, primaryName, compatibleName) {
  return boundedText(env?.[primaryName] || env?.[compatibleName], 10_000);
}

function unavailable(status, message) {
  return {
    available: false,
    status,
    message,
    results: []
  };
}

function failed(status, message) {
  return {
    available: true,
    status,
    message,
    results: []
  };
}

function parseAllowedHosts(rawValue, endpointHostname) {
  const configured = rawValue
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);

  // 精确匹配小写 hostname，不支持通配符或“后缀包含”，避免恶意相似域名绕过。
  // 未额外配置时仍只允许请求固定 endpoint 的 host，不会放开任意目标。
  return new Set(configured.length ? configured : [endpointHostname]);
}

function readCandidateResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.webPages?.value)) return payload.webPages.value;
  if (Array.isArray(payload?.data?.webPages?.value)) return payload.data.webPages.value;
  return null;
}

function normalizeResult(candidate, index) {
  if (!candidate || typeof candidate !== 'object') return null;

  const rawUrl = boundedText(
    candidate.url || candidate.link,
    WEB_SEARCH_LIMITS.maxUrlLength
  );
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  // 检索结果也只输出 HTTPS 链接，避免将不安全协议传到前端。
  if (parsedUrl.protocol !== 'https:') return null;

  const url = parsedUrl.toString().slice(0, WEB_SEARCH_LIMITS.maxUrlLength);
  const title = boundedText(
    candidate.title || candidate.name,
    WEB_SEARCH_LIMITS.maxTitleLength
  ) || parsedUrl.hostname;
  const snippet = boundedText(
    candidate.snippet || candidate.summary || candidate.description || candidate.content || candidate.text,
    WEB_SEARCH_LIMITS.maxSnippetLength
  );
  const id = boundedText(candidate.id, 200) || `web-${index + 1}`;
  const proposedSourceKind = boundedText(candidate.sourceKind || candidate.source_kind, 80);
  const sourceKind = SOURCE_KINDS.has(proposedSourceKind)
    ? proposedSourceKind
    : 'public_web';
  const publishedAt = boundedText(
    candidate.publishedAt || candidate.published_at || candidate.datePublished || candidate.date,
    80
  );

  return {
    id,
    title,
    url,
    snippet,
    source: 'web',
    providerRank: index + 1,
    sourceKind,
    sourceDomain: parsedUrl.hostname.toLowerCase(),
    publishedAt
  };
}

/**
 * 从兼容的 payload 形态读取 results，过滤非法项/非 HTTPS URL、去重并限制条数。
 * 返回 null 表示响应结构本身不合法；返回 [] 表示结构合法但没有安全可用结果。
 */
export function normalizeWebSearchResults(payload, limit = WEB_SEARCH_LIMITS.maxResults) {
  const candidates = readCandidateResults(payload);
  if (!candidates) return null;

  const safeLimit = Math.min(
    WEB_SEARCH_LIMITS.maxResults,
    Math.max(1, Number.isInteger(limit) ? limit : WEB_SEARCH_LIMITS.maxResults)
  );
  const seenUrls = new Set();
  const results = [];

  for (const candidate of candidates) {
    const normalized = normalizeResult(candidate, results.length);
    if (!normalized || seenUrls.has(normalized.url)) continue;
    seenUrls.add(normalized.url);
    results.push(normalized);
    if (results.length >= safeLimit) break;
  }

  return results;
}

/**
 * 有 Content-Length 时先快速拒绝；没有或标注不可信时仍逐 chunk 累计真实字节数。
 * 超限会主动 cancel reader，避免继续下载大响应。这里限制的是 UTF-8 解码前字节数，
 * 比限制 JavaScript 字符数更贴近实际内存和带宽风险。
 */
async function readLimitedText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ResponseTooLargeError();
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ResponseTooLargeError();
    return new TextDecoder().decode(buffer);
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * 一次性解析环境配置。成功输出经过验证的 URL 与 Key，失败输出统一 unavailable 结果。
 * endpoint 必须是无内嵌账号密码的 HTTPS URL，并且 hostname 精确位于允许集合中。
 */
function resolveConfiguration(env) {
  const endpointValue = getEnvValue(
    env,
    'RESEARCH_WEB_SEARCH_ENDPOINT',
    'WEB_SEARCH_ENDPOINT'
  );
  const apiKey = getEnvValue(
    env,
    'RESEARCH_WEB_SEARCH_API_KEY',
    'WEB_SEARCH_API_KEY'
  );
  const allowedHostsValue = getEnvValue(
    env,
    'RESEARCH_WEB_SEARCH_ALLOWED_HOSTS',
    'WEB_SEARCH_ALLOWED_HOSTS'
  );

  // Bocha 是项目内建的轻量适配：只需一枚 Key，endpoint 与 host 固定在代码中，
  // 不接受用户输入的 URL。显式配置通用 endpoint 时仍优先走通用 provider，便于
  // 部署者替换服务商或接入内部网关。
  const bochaApiKey = boundedText(env?.BOCHA_API_KEY, 10_000);
  if (!endpointValue && !apiKey && bochaApiKey) {
    return {
      provider: 'bocha',
      endpoint: new URL(BOCHA_WEB_SEARCH_ENDPOINT),
      apiKey: bochaApiKey,
      allowedHosts: new Set([BOCHA_HOST])
    };
  }

  if (!endpointValue || !apiKey) {
    return {
      error: unavailable(
        'not_configured',
        '未配置联网检索 endpoint 或 API Key，已降级为本地资料检索。'
      )
    };
  }

  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    return { error: unavailable('invalid_endpoint', '联网检索 endpoint 格式无效。') };
  }

  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    return {
      error: unavailable(
        'invalid_endpoint',
        '联网检索 endpoint 必须使用 HTTPS，且不能在 URL 中携带凭据。'
      )
    };
  }

  const allowedHosts = parseAllowedHosts(allowedHostsValue, endpoint.hostname.toLowerCase());
  if (!allowedHosts.has(endpoint.hostname.toLowerCase())) {
    return {
      error: unavailable(
        'host_not_allowed',
        '联网检索 endpoint 不在配置的 host 白名单中。'
      )
    };
  }

  return { provider: 'generic', endpoint, apiKey, allowedHosts };
}

/**
 * 创建具有固定安全参数的 Provider。对合法输入，search(query, { topK, signal }) 会
 * resolve 为 { available, status, message, results }，预期的配置/上游错误不会 throw。
 * 外部 signal 用于用户取消，内部 controller 用于超时；两者任一触发都会终止 fetch。
 */
export function createWebSearchProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl 必须是函数');
  }

  const configuration = resolveConfiguration(env);
  const safeTimeoutMs = Math.min(60_000, Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const safeMaxResponseBytes = Math.min(
    2 * 1024 * 1024,
    Math.max(1024, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES)
  );

  return {
    async search(query, { topK = 5, signal } = {}) {
      // 配置错误在创建时已经固化；每次调用只返回副本，且绝不把 endpoint/Key 暴露出去。
      if (configuration.error) return { ...configuration.error };

      const normalizedQuery = boundedText(query, WEB_SEARCH_LIMITS.maxQueryLength);
      if (!normalizedQuery) {
        return failed('invalid_request', '联网检索 query 不能为空。');
      }

      const limit = Math.min(
        WEB_SEARCH_LIMITS.maxResults,
        Math.max(1, Number.isInteger(topK) ? topK : 5)
      );
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), safeTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      let response;
      try {
        const body = configuration.provider === 'bocha'
          ? { query: normalizedQuery, count: limit, summary: true }
          : { query: normalizedQuery, topK: limit };
        response = await fetchImpl(configuration.endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${configuration.apiKey}`
          },
          body: JSON.stringify(body),
          // 即便固定 endpoint 本身可信，也禁止 3xx 把带 Authorization 的请求导向别处。
          redirect: 'error',
          signal: requestSignal
        });

        if (!response?.ok) {
          const statusCode = Number(response?.status) || 502;
          if (statusCode === 401 || statusCode === 403) {
            return failed('authentication_failed', '联网检索服务拒绝了凭据。');
          }
          if (statusCode === 429) {
            return failed('rate_limited', '联网检索服务请求过于频繁。');
          }
          return failed('upstream_http_error', `联网检索服务返回 HTTP ${statusCode}。`);
        }

        const text = await readLimitedText(response, safeMaxResponseBytes);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return failed('invalid_response', '联网检索服务返回了无效 JSON。');
        }

        const results = normalizeWebSearchResults(payload, limit);
        if (!results) {
          return failed('invalid_response', '联网检索服务缺少 results 数组。');
        }

        return {
          available: true,
          status: 'success',
          message: results.length
            ? `联网检索返回 ${results.length} 条结果。`
            : '联网检索未找到可用结果。',
          results
        };
      } catch (error) {
        // 错误顺序很重要：先保留具体的大小限制，再区分用户取消与内部超时。
        if (error instanceof ResponseTooLargeError) {
          return failed('response_too_large', error.message);
        }
        if (signal?.aborted) {
          return failed('cancelled', '联网检索已取消。');
        }
        if (timeoutController.signal.aborted) {
          return failed('timeout', '联网检索服务响应超时。');
        }
        return failed('network_error', '无法连接联网检索服务。');
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
