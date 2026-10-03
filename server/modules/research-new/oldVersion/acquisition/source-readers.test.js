import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchNewSourceReader } from './source-readers.js';

function createReader(overrides = {}) {
  const calls = [];
  const reader = createResearchNewSourceReader({
    now: () => 123,
    webDocumentReader: {
      async readWebDocument(input) {
        calls.push({ type: 'web', ...input });
        if (overrides.webError) throw overrides.webError;
        return {
          title: 'Extracted article',
          content: '普通网页经过安全 Reader 取得并由 Readability 提取的完整正文。'.repeat(5),
          contentHash: 'web-hash',
          truncated: false
        };
      }
    },
    safeReader: {
      async readText(input) {
        calls.push({ type: 'safe', ...input });
        return { text: 'GitHub README 的完整正文。'.repeat(10) };
      }
    }
  });
  return { reader, calls };
}

test('四类真实 Adapter 按优先级转换成统一 SourceDocument', async () => {
  const { reader, calls } = createReader();
  assert.deepEqual(reader.adapters.map((item) => item.id), [
    'workspace_document', 'provider_content', 'github_readme', 'web_page'
  ]);

  const workspace = await reader.read({
    id: 'local-1', origin: 'workspace', title: '项目文档', content: '项目约束与实现细节。'
  });
  assert.equal(workspace.document.readerKind, 'workspace_document');
  assert.equal(workspace.document.contentLevel, 'partial_text');
  assert.equal(workspace.document.fetchedAt, 123);

  const provider = await reader.read({
    id: 'web-raw', origin: 'web', title: 'Provider', url: 'https://provider.example/a',
    rawContent: 'Provider 返回的独立正文。', rawContentComplete: false
  });
  assert.equal(provider.document.readerKind, 'provider_content');
  assert.equal(provider.document.contentLevel, 'partial_text');

  const github = await reader.read({
    id: 'github-1', origin: 'web', title: 'Repo', url: 'https://github.com/openai/example'
  });
  assert.equal(github.document.readerKind, 'github_readme');
  assert.match(calls.find((item) => item.type === 'safe').url, /api\.github\.com\/repos\/openai\/example\/readme/);

  const githubPage = await reader.read({
    id: 'github-page', origin: 'web', title: 'Issue', url: 'https://github.com/openai/example/issues/1'
  });
  assert.equal(githubPage.document.readerKind, 'web_page');

  const webpage = await reader.read({
    id: 'page-1', origin: 'web', title: 'Page', url: 'https://docs.example/article'
  });
  assert.equal(webpage.document.readerKind, 'web_page');
  assert.equal(webpage.document.id, 'page-1');
  assert.equal(webpage.document.contentHash, 'web-hash');
  assert.equal(calls.filter((item) => item.type === 'web').length, 2);
});

test('网页读取失败保留结构化 failure，并把明确 snippet 降级为薄证据', async () => {
  const error = Object.assign(new Error('timeout detail should not leak'), { code: 'WEB_READER_TIMEOUT' });
  const { reader } = createReader({ webError: error });
  const result = await reader.read({
    id: 'page-2',
    origin: 'web',
    title: 'Unavailable page',
    url: 'https://docs.example/unavailable',
    snippet: '搜索 Provider 返回的摘要，只能作为薄证据。'
  });
  assert.equal(result.document.readerKind, 'search_snippet');
  assert.equal(result.document.contentLevel, 'snippet');
  assert.deepEqual(result.failure, {
    sourceId: 'page-2',
    code: 'WEB_READER_TIMEOUT',
    message: '来源正文读取失败',
    retryable: true
  });
});

test('正文按 UTF-8 字节上限截断，身份仍基于完整规范化正文', async () => {
  const { reader } = createReader();
  const content = '中'.repeat(60_000);
  const result = await reader.read({
    id: 'large-provider',
    origin: 'web',
    rawContent: content
  });
  assert.equal(Buffer.byteLength(result.document.content, 'utf8') <= 160_000, true);
  assert.equal(result.document.content.includes('\ufffd'), false);
  assert.equal(result.document.truncated, true);
  assert.notEqual(result.document.contentHash, result.document.content);
});

test('无 snippet 的读取失败不会伪造 document，取消不会降级', async () => {
  const { reader } = createReader({
    webError: Object.assign(new Error('blocked'), { code: 'WEB_READER_ADDRESS_BLOCKED' })
  });
  const failed = await reader.read({
    id: 'page-3', origin: 'web', url: 'https://blocked.example/'
  });
  assert.equal(failed.document, null);
  assert.equal(failed.failure.code, 'WEB_READER_ADDRESS_BLOCKED');

  const cancelled = createResearchNewSourceReader({
    now: () => 123,
    safeReader: { readText: async () => ({ text: '' }) },
    webDocumentReader: {
      async readWebDocument() {
        throw Object.assign(new Error('cancelled'), { code: 'WEB_READER_CANCELLED' });
      }
    }
  });
  await assert.rejects(
    cancelled.read({ id: 'page-4', origin: 'web', url: 'https://example.test', snippet: '摘要' }),
    (error) => error.code === 'WEB_READER_CANCELLED'
  );
});

test('Provider 正文优先于 URL Reader，避免不必要的二次联网', async () => {
  const { reader, calls } = createReader();
  const result = await reader.read({
    id: 'provider-first',
    origin: 'web',
    url: 'https://docs.example/raw',
    rawContent: 'Provider 已返回正文。',
    snippet: '摘要'
  });
  assert.equal(result.document.readerKind, 'provider_content');
  assert.equal(calls.length, 0);
});
