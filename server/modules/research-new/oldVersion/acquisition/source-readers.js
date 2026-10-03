import { createHash } from 'node:crypto';

const MAX_SOURCE_BYTES = 160_000;

function normalizedText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentHash(value) {
  return createHash('sha256').update(normalizedText(value)).digest('hex');
}

function boundedContent(value) {
  const full = normalizedText(value);
  const fullBuffer = Buffer.from(full, 'utf8');
  let end = Math.min(fullBuffer.byteLength, MAX_SOURCE_BYTES);
  while (end > 0 && end < fullBuffer.byteLength && (fullBuffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    content: fullBuffer.subarray(0, end).toString('utf8'),
    contentHash: contentHash(full),
    truncated: fullBuffer.byteLength > MAX_SOURCE_BYTES
  };
}

function githubRepository(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repository] = parts;
    if (!owner || !repository) return null;
    if (!/^[a-z0-9_.-]+$/iu.test(owner) || !/^[a-z0-9_.-]+$/iu.test(repository)) return null;
    return { owner, repository: repository.replace(/\.git$/iu, '') };
  } catch {
    return null;
  }
}

function sourceDocument(source, fields, now) {
  const bounded = boundedContent(fields.content);
  if (!bounded.content) {
    const error = new Error('来源没有可读取内容');
    error.code = 'SOURCE_CONTENT_EMPTY';
    throw error;
  }
  return {
    id: String(source.id || ''),
    origin: source.origin,
    url: source.url ? String(source.url) : undefined,
    title: String(fields.title || source.title || '').slice(0, 500),
    content: bounded.content,
    contentHash: fields.contentHash || bounded.contentHash,
    fetchedAt: now(),
    readerKind: fields.readerKind,
    contentLevel: fields.contentLevel,
    truncated: Boolean(fields.truncated || bounded.truncated)
  };
}

function safeFailure(error, source) {
  const code = typeof error?.code === 'string' ? error.code : 'SOURCE_READ_FAILED';
  return {
    sourceId: String(source?.id || ''),
    code,
    message: code === 'WEB_READER_CANCELLED' ? '来源读取已取消' : '来源正文读取失败',
    retryable: new Set([
      'WEB_READER_TIMEOUT',
      'WEB_READER_UPSTREAM_ERROR',
      'WEB_READER_HTTP_ERROR',
      'WEB_READER_BODY_INVALID'
    ]).has(code)
  };
}

export function createResearchNewSourceReader({
  webDocumentReader,
  safeReader,
  now = Date.now
}) {
  if (!webDocumentReader?.readWebDocument || !safeReader?.readText) {
    throw new TypeError('Research New Source Reader 需要 webDocumentReader 与 safeReader');
  }

  const adapters = [
    {
      id: 'workspace_document',
      canRead: (source) => source.origin === 'workspace',
      async read(source) {
        return sourceDocument(source, {
          content: source.content || source.snippet,
          readerKind: 'workspace_document',
          contentLevel: 'partial_text'
        }, now);
      }
    },
    {
      id: 'provider_content',
      canRead: (source) => source.origin === 'web'
        && typeof source.rawContent === 'string'
        && source.rawContent.trim().length > 0,
      async read(source) {
        return sourceDocument(source, {
          content: source.rawContent,
          readerKind: 'provider_content',
          contentLevel: source.rawContentComplete === true ? 'full_text' : 'partial_text'
        }, now);
      }
    },
    {
      id: 'github_readme',
      canRead: (source) => source.origin === 'web' && Boolean(githubRepository(source.url)),
      async read(source, signal) {
        const repository = githubRepository(source.url);
        const result = await safeReader.readText({
          url: `https://api.github.com/repos/${repository.owner}/${repository.repository}/readme`,
          signal,
          accept: 'application/vnd.github.raw+json, text/plain;q=0.9',
          allowedContentTypes: [
            'application/vnd.github.raw+json',
            'text/plain',
            'application/octet-stream'
          ]
        });
        return sourceDocument(source, {
          content: result.text,
          readerKind: 'github_readme',
          contentLevel: 'full_text'
        }, now);
      }
    },
    {
      id: 'web_page',
      canRead: (source) => source.origin === 'web' && typeof source.url === 'string',
      async read(source, signal) {
        const result = await webDocumentReader.readWebDocument({ url: source.url, signal });
        return sourceDocument(source, {
          title: result.title,
          content: result.content,
          contentHash: result.contentHash,
          truncated: result.truncated,
          readerKind: 'web_page',
          contentLevel: result.truncated ? 'partial_text' : 'full_text'
        }, now);
      }
    }
  ];

  async function read(source, { signal, allowSnippetFallback = true } = {}) {
    const adapter = adapters.find((candidate) => candidate.canRead(source));
    if (!adapter) {
      const error = Object.assign(new Error('来源未命中 Reader Adapter'), {
        code: 'SOURCE_ADAPTER_NOT_FOUND'
      });
      if (!allowSnippetFallback || !normalizedText(source?.snippet)) throw error;
      return {
        document: sourceDocument(source, {
          content: source.snippet,
          readerKind: 'search_snippet',
          contentLevel: 'snippet'
        }, now),
        failure: safeFailure(error, source)
      };
    }

    try {
      return { document: await adapter.read(source, signal), failure: null };
    } catch (error) {
      if (signal?.aborted || error?.code === 'WEB_READER_CANCELLED') throw error;
      const failure = safeFailure(error, source);
      if (!allowSnippetFallback || !normalizedText(source?.snippet)) {
        return { document: null, failure };
      }
      return {
        document: sourceDocument(source, {
          content: source.snippet,
          readerKind: 'search_snippet',
          contentLevel: 'snippet'
        }, now),
        failure
      };
    }
  }

  return { read, adapters };
}
