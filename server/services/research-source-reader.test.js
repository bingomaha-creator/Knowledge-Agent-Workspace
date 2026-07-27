import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchSourceReader } from './research-source-reader.js';

test('reader rewrites a GitHub repository to the fixed README API and bounds persisted content', async () => {
  let requested;
  const reader = createResearchSourceReader({
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return new Response('# OpenHands\n\nOfficial repository documentation.', {
        headers: { 'content-type': 'text/plain' }
      });
    }
  });
  const result = await reader.readSelected({
    sources: [{
      id: 'openhands',
      kind: 'web',
      url: 'https://github.com/All-Hands-AI/OpenHands'
    }]
  });

  assert.equal(requested.url, 'https://api.github.com/repos/All-Hands-AI/OpenHands/readme');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.documents[0].readerKind, 'github_readme');
  assert.match(result.documents[0].content, /Official repository/);
});
test('reader does not fetch arbitrary search-result hosts', async () => {
  let fetchCalls = 0;
  const reader = createResearchSourceReader({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('should not run');
    }
  });
  const result = await reader.readSelected({
    sources: [{
      id: 'generic',
      kind: 'web',
      url: 'https://unknown.example/article'
    }]
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.documents.length, 0);
  assert.equal(result.failures[0].code, 'unsupported_source');
});

test('local evidence is available to the assembler without network access', async () => {
  const reader = createResearchSourceReader({
    fetchImpl: async () => { throw new Error('network should not run'); }
  });
  const result = await reader.readSelected({
    sources: [{ id: 'local', kind: 'local', snippet: '本地命中片段。' }]
  });
  assert.equal(result.documents[0].content, '本地命中片段。');
  assert.equal(result.documents[0].readerKind, 'local_evidence');
});
