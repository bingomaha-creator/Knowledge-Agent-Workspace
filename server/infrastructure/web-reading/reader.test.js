import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebDocumentReader } from './reader.js';

test('Web Document Reader 组合安全响应与 Readability 正文', async () => {
  const html = `<!doctype html><html><head><title>Research article</title></head><body>
    <nav>Home Products Login</nav><article><h1>Research article</h1>
    <p>${'Evidence must be extracted from content that the reader actually obtained. '.repeat(4)}</p>
    <p>${'Search snippets and full documents need distinct content levels in the research state. '.repeat(4)}</p>
    </article></body></html>`;
  const reader = createWebDocumentReader({
    safeReader: {
      async readText({ url }) {
        return {
          url,
          finalUrl: 'https://docs.example/final',
          contentType: 'text/html',
          text: html,
          redirectCount: 1
        };
      }
    }
  });
  const document = await reader.readWebDocument({ url: 'https://docs.example/start' });
  assert.equal(document.finalUrl, 'https://docs.example/final');
  assert.match(document.content, /Evidence must be extracted/);
  assert.doesNotMatch(document.content, /Home Products Login/);
  assert.match(document.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(document.redirectCount, 1);
});
