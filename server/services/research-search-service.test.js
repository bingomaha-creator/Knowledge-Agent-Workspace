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

// —— Web SearchProvider 调用边界（Spec research-harness §9.1）——
// onWebSearchAttempt 必须只在真正发起 search_web 时触发：local 不发起即不触发、
// 发起后抛错仍触发（调用已发生）；观察者触发次数与 Provider 实际调用次数一致，
// 未来引入缓存时命中路径不经过 callTool 也就不会计数。

test('search service fires onWebSearchAttempt only when search_web is actually initiated', async () => {
  let toolCalls = 0;
  const service = createResearchSearchService({
    searchEvidence: async () => ({ evidence: [] }),
    toolExecutor: {
      callTool: async () => {
        toolCalls += 1;
        return { structured: { available: true, status: 'success', results: [] } };
      }
    }
  });

  let attempts = 0;
  await service.searchSources({
    query: '混合查询',
    searchMode: 'hybrid',
    onWebSearchAttempt: () => { attempts += 1; }
  });
  assert.equal(attempts, 1, 'hybrid 一次检索恰好看起一次 Provider 调用');
  assert.equal(toolCalls, 1, '观察者触发次数与 Provider 调用次数一致（未来缓存命中不计数的基础）');
});

test('search service does not fire onWebSearchAttempt in local mode', async () => {
  let toolCalls = 0;
  const service = createResearchSearchService({
    searchEvidence: async () => ({ evidence: [{ id: 'c1', title: 't', snippet: 's', source: 'x' }] }),
    toolExecutor: {
      callTool: async () => {
        toolCalls += 1;
        return { structured: { available: true, status: 'success', results: [] } };
      }
    }
  });

  let attempts = 0;
  await service.searchSources({
    query: '本地查询',
    searchMode: 'local',
    onWebSearchAttempt: () => { attempts += 1; }
  });
  assert.equal(attempts, 0, 'local 模式不发起 Provider 调用，不计数');
  assert.equal(toolCalls, 0);
});

test('search service counts the attempt even when the provider call throws afterwards', async () => {
  const service = createResearchSearchService({
    searchEvidence: async () => ({ evidence: [] }),
    toolExecutor: {
      callTool: async () => {
        throw new Error('provider exploded after being called');
      }
    }
  });

  let attempts = 0;
  const result = await service.searchSources({
    query: '降级查询',
    searchMode: 'hybrid',
    onWebSearchAttempt: () => { attempts += 1; }
  });
  assert.equal(attempts, 1, '调用已发起，抛错后仍计数');
  assert.equal(result.webSearchStatus, 'error');
});

test('search service survives observer failures', async () => {
  const service = createResearchSearchService({
    searchEvidence: async () => ({ evidence: [] }),
    toolExecutor: {
      callTool: async () => ({ structured: { available: true, status: 'success', results: [] } })
    }
  });

  const result = await service.searchSources({
    query: '观察者异常',
    searchMode: 'hybrid',
    onWebSearchAttempt: () => { throw new Error('observer boom'); }
  });
  assert.equal(result.webSearchStatus, 'available', '观察者异常不影响检索结果');
});

// —— 检索模式语义（Spec research-harness §6.1，Phase 2A 修复项）——

test('web mode never starts local search and never returns local evidence', async () => {
  let localSearchCalls = 0;
  const service = createResearchSearchService({
    searchEvidence: async () => {
      localSearchCalls += 1;
      return { evidence: [{ id: 'l1', title: '本地', snippet: '本地内容', source: '本地知识库' }] };
    },
    toolExecutor: {
      callTool: async () => ({ structured: { available: true, status: 'success', results: [{ id: 'w1', title: '外部', url: 'https://example.org/1', snippet: '外部内容' }] } })
    }
  });

  const result = await service.searchSources({ query: 'q', searchMode: 'web' });
  assert.equal(localSearchCalls, 0, 'web 模式不得启动本地检索（历史偏差修复）');
  assert.equal(result.local.length, 0, 'web 模式不得返回本地证据');
  assert.equal(result.web.length, 1);
  assert.equal(result.webSearchStatus, 'available');
});

test('local mode never initiates the web provider call', async () => {
  let toolCalls = 0;
  const service = createResearchSearchService({
    searchEvidence: async () => ({ evidence: [{ id: 'l1', title: '本地', snippet: '本地内容', source: '本地知识库' }] }),
    toolExecutor: {
      callTool: async () => {
        toolCalls += 1;
        return { structured: { available: true, status: 'success', results: [] } };
      }
    }
  });

  const result = await service.searchSources({ query: 'q', searchMode: 'local' });
  assert.equal(toolCalls, 0);
  assert.equal(result.webSearchStatus, 'not_requested');
  assert.equal(result.local.length, 1);
});

test('hybrid runs local and web retrieval in parallel with channel labels preserved', async () => {
  const timings = [];
  const service = createResearchSearchService({
    searchEvidence: async () => {
      timings.push({ at: Date.now(), kind: 'local-start' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      timings.push({ at: Date.now(), kind: 'local-end' });
      return { evidence: [{ id: 'l1', title: '本地', snippet: '本地内容', source: '本地知识库' }] };
    },
    toolExecutor: {
      callTool: async () => {
        timings.push({ at: Date.now(), kind: 'web-start' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        timings.push({ at: Date.now(), kind: 'web-end' });
        return { structured: { available: true, status: 'success', results: [{ id: 'w1', title: '外部', url: 'https://example.org/1', snippet: '外部内容' }] } };
      }
    }
  });

  const result = await service.searchSources({ query: 'q', searchMode: 'hybrid' });
  const localEnd = timings.find((item) => item.kind === 'local-end').at;
  const webStart = timings.find((item) => item.kind === 'web-start').at;
  assert.ok(webStart < localEnd, 'web 检索必须在 local 结束前启动（真实并行）');
  assert.equal(result.local.length, 1);
  assert.equal(result.web.length, 1);
});
