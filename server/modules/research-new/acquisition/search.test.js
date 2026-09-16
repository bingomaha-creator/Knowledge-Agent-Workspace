import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchNewSearch } from './search.js';

test('Research New Search 并行保留 Web 与 Workspace 来源身份', async () => {
  const calls = [];
  const search = createResearchNewSearch({
    knowledgeSearch: {
      async searchEvidence(input) {
        calls.push(['local', input]);
        return { evidence: [{
          id: 'chunk-1', knowledgeBaseId: 'kb-a', documentId: 'doc-a',
          title: '项目说明', snippet: '项目使用固定运行时。'
        }] };
      }
    },
    toolExecutor: {
      async callTool(name, args, context) {
        calls.push(['web', { name, args, context }]);
        return { structured: { available: true, status: 'success', results: [{
          id: 'web-1', title: 'Release note', url: 'https://example.com/release',
          snippet: '公开版本说明', sourceKind: 'official_docs'
        }] } };
      }
    }
  });
  const result = await search.search({
    trackId: 'track-1', query: '版本说明', mode: 'hybrid', knowledgeBaseIds: ['kb-a']
  });
  assert.equal(result.webStatus, 'available');
  assert.deepEqual(result.sources.map((source) => source.origin), ['workspace', 'web']);
  assert.equal(result.sources[0].chunkId, 'chunk-1');
  assert.equal(result.sources[1].sourceKind, 'official_docs');
  assert.deepEqual(calls.map(([kind]) => kind).sort(), ['local', 'web']);
});

test('Web 模式不访问知识库', async () => {
  let localCalls = 0;
  const search = createResearchNewSearch({
    knowledgeSearch: { searchEvidence: async () => { localCalls += 1; return { evidence: [] }; } },
    toolExecutor: { callTool: async () => ({ structured: { status: 'success', results: [] } }) }
  });
  await search.search({ trackId: 'track-1', query: '公开资料', mode: 'web', knowledgeBaseIds: [] });
  assert.equal(localCalls, 0);
});
