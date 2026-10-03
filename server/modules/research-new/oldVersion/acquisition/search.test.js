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
    webSearchProvider: {
      capabilities: { provider: 'tavily', fullText: true },
      async search(query, options) {
        calls.push(['web', { query, options }]);
        return { available: true, status: 'success', results: [{
          id: 'web-1', title: 'Release note', url: 'https://example.com/release',
          snippet: '公开版本说明', rawContent: '完整公开版本说明', rawContentComplete: true,
          sourceKind: 'official_docs'
        }] };
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
    webSearchProvider: { capabilities: {}, search: async () => ({ status: 'success', results: [] }) }
  });
  await search.search({ trackId: 'track-1', query: '公开资料', mode: 'web', knowledgeBaseIds: [] });
  assert.equal(localCalls, 0);
});

test('Hybrid 分别使用 Track 问题检索本地、Planner 查询检索公网', async () => {
  const observed = {};
  const search = createResearchNewSearch({
    knowledgeSearch: {
      async searchEvidence(input) {
        observed.workspaceQuery = input.query;
        return { evidence: [] };
      }
    },
    webSearchProvider: {
      capabilities: { provider: 'tavily', fullText: true },
      async search(query) {
        observed.webQuery = query;
        return { available: true, status: 'success', results: [] };
      }
    }
  });

  await search.search({
    trackId: 'track-1',
    query: 'client state server state ownership official guidance',
    track: {
      question: '当前项目的状态归属和数据流是否清晰？',
      evidenceRequirements: ['定位 Service 边界、Query key 和 mutation 同步规则']
    },
    mode: 'hybrid',
    knowledgeBaseIds: ['kb-a']
  });

  assert.equal(observed.webQuery, 'client state server state ownership official guidance');
  assert.equal(
    observed.workspaceQuery,
    '当前项目的状态归属和数据流是否清晰？ 定位 Service 边界、Query key 和 mutation 同步规则'
  );
});

test('搜索显式记录 Provider 约束降级，并在读取前拒绝无关候选', async () => {
  const search = createResearchNewSearch({
    knowledgeSearch: { searchEvidence: async () => ({ evidence: [] }) },
    webSearchProvider: {
      capabilities: {
        provider: 'tavily', domainFilter: true, temporalFilter: true,
        freshness: true, sourceTraits: false, queryOperators: false, fullText: true
      },
      async search(query, options) {
        assert.equal(query, 'PostgreSQL 17 PostgreSQL 16 changes site:postgresql.org');
        assert.deepEqual(options.includeDomains, ['postgresql.org']);
        assert.equal(options.startDate, '2024-01-01');
        return { available: true, status: 'success', results: [
          {
            id: 'unrelated', title: 'Angular component guide',
            url: 'https://frontend.example/angular', snippet: 'Reusable UI components',
            sourceKind: 'public_web'
          },
          {
            id: 'release', title: 'PostgreSQL 17 release notes',
            url: 'https://www.postgresql.org/docs/17/release-17.html',
            snippet: 'PostgreSQL 17 changes compared with PostgreSQL 16',
            sourceKind: 'official_docs', publishedAt: '2024-09-26'
          },
          {
            id: 'old-release', title: 'PostgreSQL 17 historical release notes',
            url: 'https://www.postgresql.org/docs/old-release',
            snippet: 'PostgreSQL 17 historical changes',
            sourceKind: 'official_docs', publishedAt: '2020-01-01'
          },
          {
            id: 'numeric-substring', title: 'PostgreSQL 12 deprecation file',
            url: 'https://www.postgresql.org/library/16.8.4/postgresql-12',
            snippet: 'Package metadata', sourceKind: 'public_web'
          }
        ] };
      }
    }
  });

  const result = await search.search({
    trackId: 'track-1',
    query: 'PostgreSQL 17 PostgreSQL 16 changes site:postgresql.org',
    mode: 'web',
    knowledgeBaseIds: [],
    brief: {
      entities: [{ name: 'PostgreSQL', aliases: [] }],
      comparison: { left: 'PostgreSQL 17', right: 'PostgreSQL 16' },
      temporalScope: { from: '2024-01-01' },
      preferredSourceTraits: ['official release notes']
    },
    track: { id: 'track-1', question: '两个版本的重要变化是什么？' }
  });

  assert.deepEqual(result.sources.map((source) => source.id), [
    result.sources.find((source) => source.url.includes('release-17')).id
  ]);
  assert.deepEqual(result.constraintDegradations.map((item) => item.constraint).sort(), [
    'source_traits'
  ]);
  assert.deepEqual(result.screening.rejected.map((item) => item.reason).sort(), [
    'domain_mismatch',
    'entity_mismatch',
    'temporal_mismatch'
  ]);
});

test('Hybrid Web 候选可按当前 Track 匹配，不被项目型 Brief 实体误拒', async () => {
  const search = createResearchNewSearch({
    knowledgeSearch: { searchEvidence: async () => ({ evidence: [] }) },
    webSearchProvider: {
      capabilities: { provider: 'tavily', fullText: true },
      async search() {
        return { available: true, status: 'success', results: [{
          id: 'storybook-a11y',
          title: 'Accessibility testing with Storybook',
          url: 'https://storybook.js.org/docs/writing-tests/accessibility-testing',
          snippet: 'The addon-a11y integration checks rendered stories against WCAG accessibility rules.',
          sourceKind: 'official_docs'
        }] };
      }
    }
  });

  const result = await search.search({
    trackId: 'track-3',
    query: 'Storybook addon-a11y automated accessibility checks React',
    mode: 'hybrid',
    knowledgeBaseIds: ['kb-a'],
    brief: {
      entities: [{ name: 'Current Project Architecture', aliases: [] }],
      preferredSourceTraits: ['official engineering guidance']
    },
    track: {
      id: 'track-3',
      question: 'How can UI accessibility rules be checked automatically?',
      evidenceRequirements: ['Storybook accessibility testing guidance']
    }
  });

  assert.deepEqual(result.sources.map((source) => source.url), [
    'https://storybook.js.org/docs/writing-tests/accessibility-testing'
  ]);
  assert.deepEqual(result.screening.rejected, []);
});
