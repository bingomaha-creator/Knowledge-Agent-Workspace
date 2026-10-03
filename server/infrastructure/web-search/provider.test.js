import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTavilyWebSearchProvider,
  createWebSearchProvider,
  normalizeWebSearchResults,
  TAVILY_WEB_SEARCH_CAPABILITIES,
  WEB_SEARCH_LIMITS
} from './provider.js';

const configuredEnv = {
  RESEARCH_WEB_SEARCH_ENDPOINT: 'https://search.example.test/v1/search',
  RESEARCH_WEB_SEARCH_API_KEY: 'super-secret-key',
  RESEARCH_WEB_SEARCH_ALLOWED_HOSTS: 'search.example.test'
};

test('Tavily provider requests markdown raw content and maps it into the shared result contract', async () => {
  let captured;
  const provider = createTavilyWebSearchProvider({
    env: { TAVILY_API_KEY: 'tvly-secret-key' },
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({
        results: [{
          title: 'PostgreSQL 17 Release Notes',
          url: 'https://www.postgresql.org/docs/17/release-17.html',
          content: 'PostgreSQL 17 contains significant improvements.',
          raw_content: '# PostgreSQL 17\n\nFull release notes.',
          published_date: '2024-09-26',
          score: 0.98
        }]
      });
    }
  });

  const result = await provider.search('PostgreSQL 17 changes', {
    topK: 5,
    includeDomains: ['postgresql.org'],
    startDate: '2024-01-01',
    endDate: '2024-12-31'
  });

  assert.equal(captured.url, 'https://api.tavily.com/search');
  assert.equal(captured.options.headers.Authorization, 'Bearer tvly-secret-key');
  assert.deepEqual(JSON.parse(captured.options.body), {
    query: 'PostgreSQL 17 changes',
    max_results: 5,
    search_depth: 'advanced',
    include_answer: false,
    include_raw_content: 'markdown',
    include_domains: ['postgresql.org'],
    start_date: '2024-01-01',
    end_date: '2024-12-31'
  });
  assert.deepEqual(result.capabilities, TAVILY_WEB_SEARCH_CAPABILITIES);
  assert.equal(result.results[0].rawContent, '# PostgreSQL 17\n\nFull release notes.');
  assert.equal(result.results[0].rawContentComplete, true);
  assert.equal(result.results[0].snippet, 'PostgreSQL 17 contains significant improvements.');
  assert.equal(result.results[0].publishedAt, '2024-09-26');
  assert.doesNotMatch(JSON.stringify(result), /tvly-secret-key/);
});

test('Tavily provider is unavailable without a key and keeps missing raw content explicit', async () => {
  let calls = 0;
  const unavailable = createTavilyWebSearchProvider({
    env: {},
    fetchImpl: async () => { calls += 1; return Response.json({ results: [] }); }
  });
  assert.equal((await unavailable.search('query')).status, 'not_configured');
  assert.equal(calls, 0);

  const provider = createTavilyWebSearchProvider({
    env: { TAVILY_API_KEY: 'tvly-secret-key' },
    fetchImpl: async () => Response.json({
      results: [{
        title: 'Snippet only',
        url: 'https://example.com/item',
        content: 'Only a search excerpt is available.',
        raw_content: null
      }]
    })
  });
  const result = await provider.search('query');
  assert.equal(result.results[0].rawContent, undefined);
  assert.equal(result.results[0].rawContentComplete, false);
});

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
