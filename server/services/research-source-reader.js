import { createHash } from 'node:crypto';

const MAX_DOCUMENT_BYTES = 160_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function contentHashOf(content) {
  return createHash('sha256').update(String(content || '').replace(/\r/g, '').replace(/\u0000/g, '').trim()).digest('hex');
}

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

const RETRYABLE_READER_CODES = new Set(['upstream_error', 'timeout', 'source_too_large']);

function safeReaderFailure(source, code) {
  const messages = {
    unsupported_source: '来源未命中任何受控 Reader Adapter（通用 URL Reader 属 Phase 2B，保持关闭）。',
    not_found: '未找到可读取的仓库 README。',
    upstream_error: '来源正文读取失败。',
    source_too_large: '来源正文超过读取上限。',
    timeout: '来源正文读取超时。'
  };
  return {
    sourceId: source.id,
    code,
    message: messages[code] || messages.upstream_error,
    retryable: RETRYABLE_READER_CODES.has(code)
  };
}

/**
 * Phase 2A 受控 Reader（Spec research-harness §6.3）。
 *
 * 读取顺序由 Adapter 注册表决定：
 * 1. provider_raw——搜索 Provider 已返回的受控 raw content，避免二次访问任意 URL；
 * 2. github_readme——明确 allowlist Adapter：GitHub 请求改写到固定 API 主机，
 *    redirect: 'error'，禁止任意跳转，避免把搜索结果变成 SSRF 入口。
 * 通用 HTTPS HTML/PDF Reader 属于 Phase 2B，本阶段不注册（canRead 恒 false 即
 * 等价于不存在）；每个失败都携带 sourceId/code/message/retryable，禁止无声回退
 * 为"已精读正文"——snippet 回退由证据装配阶段标记 readerKind='search_snippet' 并降质。
 *
 * attestation（Codex Phase 2A 评审第 2 点）：Adapter 显式声明内容的取得方式。
 * 内置 Adapter 默认只证明"内容由该 Reader 获取"（reader_obtained）——provider_raw
 * 与任意 GitHub README 读取成功都不得自动升级 verified_primary；只有来源身份与
 * 官方主体关系经过明确验证的 Adapter 才能声明 verified_primary，不得靠域名或
 * 搜索结果标签推断。document 同时携带全量正文的 contentHash（Ledger 身份直接
 * 采用，避免对截断文本重算）。
 */
export function createResearchSourceReader({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxDocumentBytes = MAX_DOCUMENT_BYTES
} = {}) {
  const adapters = [
    {
      id: 'provider_raw',
      canRead: (source) => source.kind === 'web'
        && typeof source.content === 'string'
        && source.content.trim().length > 0,
      read: async (source) => {
        const bounded = boundedText(source.content, maxDocumentBytes);
        return {
          sourceId: source.id,
          content: bounded.content,
          contentType: 'text/plain',
          truncated: bounded.truncated,
          readerKind: 'provider_raw',
          contentHash: contentHashOf(bounded.content),
          attestation: {
            provenance: 'reader_obtained',
            reason: 'content_from_search_provider_payload'
          }
        };
      }
    },
    {
      id: 'github_readme',
      canRead: (source) => source.kind === 'web' && Boolean(githubRepository(source.url)),
      read: async (source, signal) => {
        const repository = githubRepository(source.url);
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
            readerKind: 'github_readme',
            contentHash: contentHashOf(bounded.content),
            attestation: {
              provenance: 'reader_obtained',
              reason: 'content_from_github_readme_endpoint'
            }
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
    }
  ];

  async function readSource(source, signal) {
    if (source.kind !== 'web') {
      const bounded = boundedText(source.snippet, maxDocumentBytes);
      return {
        sourceId: source.id,
        content: bounded.content,
        contentType: 'text/plain',
        truncated: bounded.truncated,
        readerKind: 'local_evidence',
        contentHash: contentHashOf(bounded.content),
        attestation: {
          provenance: 'reader_obtained',
          reason: 'local_project_knowledge_evidence'
        }
      };
    }

    const adapter = adapters.find((candidate) => candidate.canRead(source));
    if (!adapter) {
      throw Object.assign(new Error('不支持的来源'), { code: 'UNSUPPORTED_SOURCE' });
    }
    return adapter.read(source, signal);
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

  return { readSource, readSelected, adapters };
}
