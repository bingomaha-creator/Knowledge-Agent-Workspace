import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebSearchProvider,
  normalizeWebSearchResults,
  WEB_SEARCH_LIMITS
} from './web-search-provider.js';

const configuredEnv = {
  RESEARCH_WEB_SEARCH_ENDPOINT: 'https://search.example.test/v1/search',
  RESEARCH_WEB_SEARCH_API_KEY: 'super-secret-key',
  RESEARCH_WEB_SEARCH_ALLOWED_HOSTS: 'search.example.test'
};

test('unconfigured provider degrades without performing a request', async () => {
  let requestCount = 0;
  const provider = createWebSearchProvider({
    env: {},
    fetchImpl: async () => {
      requestCount += 1;
      throw new Error('should not run');
    }
  });

  const result = await provider.search('测试');

  assert.equal(requestCount, 0);
  assert.equal(result.available, false);
  assert.equal(result.status, 'not_configured');
  assert.deepEqual(result.results, []);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-key/);
});

test('provider rejects non-HTTPS and non-allowlisted endpoints before fetch', async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response('{}');
  };

  const insecure = createWebSearchProvider({
    env: {
      ...configuredEnv,
      RESEARCH_WEB_SEARCH_ENDPOINT: 'http://search.example.test/v1/search'
    },
    fetchImpl
  });
  const blocked = createWebSearchProvider({
    env: {
      ...configuredEnv,
      RESEARCH_WEB_SEARCH_ALLOWED_HOSTS: 'approved.example.test'
    },
    fetchImpl
  });

  assert.equal((await insecure.search('测试')).status, 'invalid_endpoint');
  assert.equal((await blocked.search('测试')).status, 'host_not_allowed');
  assert.equal(requestCount, 0);
});

test('provider sends the bounded adapter contract and normalizes safe results', async () => {
  let captured;
  const provider = createWebSearchProvider({
    env: configuredEnv,
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({
        results: [
          {
            id: 'primary',
            title: '  Primary result  ',
            url: 'https://docs.example.test/topic',
            description: '  useful summary  ',
            sourceKind: 'official_docs',
            publishedAt: '2026-07-01'
          },
          {
            title: 'duplicate',
            url: 'https://docs.example.test/topic',
            snippet: 'duplicate'
          },
          {
            title: 'unsafe',
            url: 'http://unsafe.example.test/',
            snippet: 'must be removed'
          },
          {
            name: 'Second result',
            link: 'https://second.example.test/item',
            text: 'second summary'
          }
        ]
      });
    }
  });

  const result = await provider.search('  深度研究  ', { topK: 99 });

  assert.equal(captured.url, configuredEnv.RESEARCH_WEB_SEARCH_ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Authorization, 'Bearer super-secret-key');
  assert.deepEqual(JSON.parse(captured.options.body), {
    query: '深度研究',
    topK: WEB_SEARCH_LIMITS.maxResults
  });
  assert.deepEqual(result, {
    available: true,
    status: 'success',
    message: '联网检索返回 2 条结果。',
    results: [
      {
        id: 'primary',
        title: 'Primary result',
        url: 'https://docs.example.test/topic',
        snippet: 'useful summary',
        source: 'web',
        providerRank: 1,
        sourceKind: 'official_docs',
        sourceDomain: 'docs.example.test',
        publishedAt: '2026-07-01'
      },
      {
        id: 'web-2',
        title: 'Second result',
        url: 'https://second.example.test/item',
        snippet: 'second summary',
        source: 'web',
        providerRank: 2,
        sourceKind: 'public_web',
        sourceDomain: 'second.example.test',
        publishedAt: ''
      }
    ]
  });
  assert.doesNotMatch(JSON.stringify(result), /super-secret-key/);
});

test('Bocha adapter uses its fixed endpoint and converts count plus webPages.value safely', async () => {
  let captured;
  const provider = createWebSearchProvider({
    env: { BOCHA_API_KEY: 'bocha-secret-key' },
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({
        webPages: {
          value: [{
            id: 'bocha-1',
            name: '官方文档',
            url: 'https://docs.example.test/research',
            snippet: 'Bocha 的标准化搜索结果。',
            summary: '摘要备用字段。',
            datePublished: '2026-07-25T00:00:00+08:00'
          }]
        }
      });
    }
  });

  const result = await provider.search(' 深度研究 Agent ', { topK: 99 });

  assert.equal(captured.url, 'https://api.bochaai.com/v1/web-search');
  assert.equal(captured.options.headers.Authorization, 'Bearer bocha-secret-key');
  assert.deepEqual(JSON.parse(captured.options.body), {
    query: '深度研究 Agent',
    count: WEB_SEARCH_LIMITS.maxResults,
    summary: true
  });
  assert.deepEqual(result.results, [{
    id: 'bocha-1',
    title: '官方文档',
    url: 'https://docs.example.test/research',
    snippet: 'Bocha 的标准化搜索结果。',
    source: 'web',
    providerRank: 1,
    sourceKind: 'public_web',
    sourceDomain: 'docs.example.test',
    publishedAt: '2026-07-25T00:00:00+08:00'
  }]);
  assert.doesNotMatch(JSON.stringify(result), /bocha-secret-key/);
});

test('normalizer accepts the compatible data.results envelope and limits fields', () => {
  const results = normalizeWebSearchResults({
    data: {
      results: [
        {
          title: 'x'.repeat(WEB_SEARCH_LIMITS.maxTitleLength + 20),
          url: 'https://example.test/a',
          content: 'y'.repeat(WEB_SEARCH_LIMITS.maxSnippetLength + 20)
        }
      ]
    }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title.length, WEB_SEARCH_LIMITS.maxTitleLength);
  assert.equal(results[0].snippet.length, WEB_SEARCH_LIMITS.maxSnippetLength);
});

test('provider classifies HTTP failures without reading or exposing their body', async () => {
  const provider = createWebSearchProvider({
    env: configuredEnv,
    fetchImpl: async () => new Response('super-secret-key upstream details', { status: 401 })
  });

  const result = await provider.search('测试');

  assert.equal(result.available, true);
  assert.equal(result.status, 'authentication_failed');
  assert.doesNotMatch(JSON.stringify(result), /super-secret-key/);
});

test('provider classifies invalid and oversized responses', async (t) => {
  await t.test('invalid JSON', async () => {
    const provider = createWebSearchProvider({
      env: configuredEnv,
      fetchImpl: async () => new Response('not-json')
    });
    assert.equal((await provider.search('测试')).status, 'invalid_response');
  });

  await t.test('oversized body', async () => {
    const provider = createWebSearchProvider({
      env: configuredEnv,
      maxResponseBytes: 1024,
      fetchImpl: async () => new Response('x'.repeat(1025))
    });
    assert.equal((await provider.search('测试')).status, 'response_too_large');
  });
});

test('provider distinguishes timeout from caller cancellation', async (t) => {
  const abortingFetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await t.test('timeout', async () => {
    const provider = createWebSearchProvider({
      env: configuredEnv,
      fetchImpl: abortingFetch,
      timeoutMs: 100
    });
    assert.equal((await provider.search('测试')).status, 'timeout');
  });

  await t.test('caller cancellation', async () => {
    const provider = createWebSearchProvider({
      env: configuredEnv,
      fetchImpl: abortingFetch,
      timeoutMs: 1000
    });
    const controller = new AbortController();
    const pending = provider.search('测试', { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).status, 'cancelled');
  });
});

test('compatible WEB_SEARCH_* variables are supported', async () => {
  const provider = createWebSearchProvider({
    env: {
      WEB_SEARCH_ENDPOINT: 'https://compatible.example.test/search',
      WEB_SEARCH_API_KEY: 'compatible-key'
    },
    fetchImpl: async () => Response.json([])
  });

  const result = await provider.search('测试');
  assert.equal(result.status, 'success');
});
