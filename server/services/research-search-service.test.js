import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchSearchService } from './research-search-service.js';

function createEvidenceSearch() {
  const evidence = [
    {
      id: 'chunk-a',
      knowledgeBaseId: 'kb-a',
      title: 'a.md / 取消',
      snippet: 'A 项目的取消边界',
      source: '混合检索知识库 / A'
    },
    {
      id: 'chunk-b',
      knowledgeBaseId: 'kb-b',
      title: 'b.md',
      snippet: 'B 项目的部署说明',
      source: '混合检索知识库 / B'
    }
  ];
  return async ({ knowledgeBaseIds }) => ({
    evidence: evidence.filter((item) => knowledgeBaseIds.includes(item.knowledgeBaseId)),
    trace: null
  });
}

test('research search service presents scoped Evidence as local research sources', async () => {
  const service = createResearchSearchService({
    searchEvidence: async ({ knowledgeBaseIds }) => ({
      evidence: knowledgeBaseIds.includes('kb-a')
        ? [{
            id: 'chunk-a',
            title: 'a.md / 取消',
            snippet: 'A 项目的取消边界',
            source: '混合检索知识库 / A',
            knowledgeBaseId: 'kb-a'
          }]
        : [],
      trace: { embedding: { ok: true } }
    }),
    toolExecutor: { async callTool() { throw new Error('web search should not run'); } },
    logger: { error() {} }
  });

  const result = await service.searchSources({
    query: '取消',
    knowledgeBaseIds: ['kb-a'],
    searchMode: 'local'
  });

  assert.deepEqual(result, {
    local: [{
      id: 'chunk-a',
      title: 'a.md / 取消',
      snippet: 'A 项目的取消边界',
      source: '混合检索知识库 / A',
      knowledgeBaseId: 'kb-a'
    }],
    web: [],
    webSearchStatus: 'not_requested'
  });
});

test('research search service keeps local evidence inside the requested project scope', async () => {
  let gatewayCalls = 0;
  const service = createResearchSearchService({
    searchEvidence: createEvidenceSearch(),
    toolExecutor: { async callTool() { gatewayCalls += 1; } },
    logger: { error() {} }
  });

  const result = await service.searchSources({
    query: '取消',
    knowledgeBaseIds: ['kb-a'],
    searchMode: 'local'
  });
  assert.deepEqual(result.local.map((item) => item.knowledgeBaseId), ['kb-a']);
  assert.deepEqual(result.web, []);
  assert.equal(result.webSearchStatus, 'not_requested');
  assert.equal(gatewayCalls, 0);
});

test('research search service preserves local evidence when controlled web search degrades', async () => {
  const service = createResearchSearchService({
    searchEvidence: createEvidenceSearch(),
    toolExecutor: {
      async callTool(name, args, context, options) {
        assert.equal(name, 'search_web');
        assert.equal(args.topK, 6);
        assert.deepEqual(context, { caller: 'research', invocation: 'orchestrated' });
        assert.equal(options.timeout, 12_000);
        return { structured: { available: false, status: 'unavailable', results: [] } };
      }
    },
    logger: { error() {} }
  });

  const result = await service.searchSources({
    query: '取消',
    knowledgeBaseIds: ['kb-a'],
    searchMode: 'hybrid'
  });
  assert.equal(result.local.length, 1);
  assert.equal(result.webSearchStatus, 'unavailable');
});

test('research search service starts local and web retrieval in parallel', async () => {
  let localStarted = false;
  let webStarted = false;
  let releaseLocal;
  let releaseWeb;
  const localGate = new Promise((resolve) => { releaseLocal = resolve; });
  const webGate = new Promise((resolve) => { releaseWeb = resolve; });
  const service = createResearchSearchService({
    searchEvidence: async () => {
      localStarted = true;
      await localGate;
      return { evidence: [], trace: null };
    },
    toolExecutor: {
      async callTool() {
        webStarted = true;
        await webGate;
        return { structured: { available: true, status: 'success', results: [] } };
      }
    },
    logger: { error() {} }
  });

  const pending = service.searchSources({ query: '并行检索', searchMode: 'hybrid' });
  await Promise.resolve();
  assert.equal(localStarted, true);
  assert.equal(webStarted, true);
  releaseLocal();
  releaseWeb();
  await pending;
});

test('research search service propagates cancellation instead of degrading it', async () => {
  const controller = new AbortController();
  const service = createResearchSearchService({
    searchEvidence: createEvidenceSearch(),
    toolExecutor: {
      async callTool() {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
    },
    logger: { error() {} }
  });

  await assert.rejects(
    service.searchSources({
      query: '取消',
      knowledgeBaseIds: ['kb-a'],
      searchMode: 'web',
      signal: controller.signal
    }),
    (error) => error.name === 'AbortError'
  );
});
