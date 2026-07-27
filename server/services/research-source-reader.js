const MAX_DOCUMENT_BYTES = 160_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function githubRepository(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    const [owner, repository] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repository) return null;
    if (!/^[a-z0-9_.-]+$/iu.test(owner) || !/^[a-z0-9_.-]+$/iu.test(repository)) return null;
    return { owner, repository: repository.replace(/\.git$/iu, '') };
  } catch {
    return null;
  }
}
function boundedText(value, maxBytes = MAX_DOCUMENT_BYTES) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { content: text, truncated: false };
  return {
    content: new TextDecoder().decode(bytes.slice(0, maxBytes)).trim(),
    truncated: true
  };
}

async function readResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error('来源正文超过读取上限');
    error.code = 'SOURCE_TOO_LARGE';
    throw error;
  }
  const text = await response.text();
  const bounded = boundedText(text, maxBytes);
  if (bounded.truncated) {
    const error = new Error('来源正文超过读取上限');
    error.code = 'SOURCE_TOO_LARGE';
    throw error;
  }
  return bounded;
}

function safeReaderFailure(source, code) {
  const messages = {
    unsupported_source: '当前仅精读项目资料和 GitHub 仓库 README。',
    not_found: '未找到可读取的仓库 README。',
    upstream_error: '来源正文读取失败。',
    source_too_large: '来源正文超过读取上限。',
    timeout: '来源正文读取超时。'
  };
  return {
    sourceId: source.id,
    code,
    message: messages[code] || messages.upstream_error
  };
}

/**
 * 第一版 Reader 只开放两个受控适配器：本地命中片段与 GitHub README。
 * GitHub 请求被改写到固定 API 主机，禁止任意 URL 跳转，避免把搜索结果变成 SSRF 入口。
 */
export function createResearchSourceReader({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxDocumentBytes = MAX_DOCUMENT_BYTES
} = {}) {
  async function readSource(source, signal) {
    if (source.kind !== 'web') {
      const bounded = boundedText(source.snippet, maxDocumentBytes);
      return {
        sourceId: source.id,
        content: bounded.content,
        contentType: 'text/plain',
        truncated: bounded.truncated,
        readerKind: 'local_evidence'
      };
    }

    const repository = githubRepository(source.url);
    if (!repository) throw Object.assign(new Error('不支持的来源'), { code: 'UNSUPPORTED_SOURCE' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository.owner}/${repository.repository}/readme`,
        {
          method: 'GET',
          redirect: 'error',
          signal: combinedSignal,
          headers: {
            Accept: 'application/vnd.github.raw+json',
            'User-Agent': 'matthews-workspace-research-reader'
          }
        }
      );
      if (response.status === 404) {
        throw Object.assign(new Error('README not found'), { code: 'NOT_FOUND' });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`GitHub ${response.status}`), { code: 'UPSTREAM_ERROR' });
      }
      const bounded = await readResponse(response, maxDocumentBytes);
      return {
        sourceId: source.id,
        content: bounded.content,
        contentType: response.headers?.get?.('content-type') || 'text/plain',
        truncated: bounded.truncated,
        readerKind: 'github_readme'
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw Object.assign(new Error('读取超时'), { code: 'TIMEOUT' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readSelected({ sources, signal }) {
    const startedAt = Date.now();
    const settled = await Promise.all((Array.isArray(sources) ? sources : []).map(async (source) => {
      try {
        return { document: await readSource(source, signal), failure: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = {
          UNSUPPORTED_SOURCE: 'unsupported_source',
          NOT_FOUND: 'not_found',
          SOURCE_TOO_LARGE: 'source_too_large',
          TIMEOUT: 'timeout'
        }[error?.code] || 'upstream_error';
        return { document: null, failure: safeReaderFailure(source, code) };
      }
    }));
    const documents = settled.map((item) => item.document).filter(Boolean);
    const failures = settled.map((item) => item.failure).filter(Boolean);
    return {
      documents,
      failures,
      diagnostics: {
        selectedSourceCount: Array.isArray(sources) ? sources.length : 0,
        readSourceCount: documents.length,
        failedSourceCount: failures.length,
        durationMs: Date.now() - startedAt
      }
    };
  }

  return { readSource, readSelected };
}
