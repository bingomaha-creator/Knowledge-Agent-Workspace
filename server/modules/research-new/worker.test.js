import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchNewStore } from './store.js';
import { createResearchNewWorker } from './worker.js';

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-new-worker-'));
  const store = createResearchNewStore(path.join(directory, 'research.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let writerCalls = 0;
  const search = overrides.search || {
    async buildWorkspaceContext() { return []; },
    async search({ trackId, query }) {
      return {
        webStatus: 'available',
        sources: [{
          id: `source-${trackId}`, trackId, origin: 'web', title: '官方发布说明',
          url: 'https://example.com/release', snippet: '搜索摘要', query,
          sourceKind: 'official_docs'
        }]
      };
    }
  };
  const sourceReader = overrides.sourceReader || {
    async read(source) {
      return {
        document: {
          id: source.id,
          title: source.title,
          content: '官方发布说明正文提供了足够长的变化描述，并明确解释新版本相较旧版本发生的可观察行为变化。',
          contentHash: 'source-hash',
          readerKind: 'web_page',
          contentLevel: 'full_text',
          fetchedAt: 123
        },
        failure: null
      };
    }
  };
  const aiService = overrides.aiService || {
    async plan() {
      return {
        brief: { objective: '研究版本变化', requiredQuestions: ['发生了什么变化？'] },
        tracks: [{
          id: 'track-1', question: '发生了什么变化？', searchQueries: ['产品 新旧版本 变化'],
          evidenceRequirements: ['直接版本证据'], status: 'pending', gaps: []
        }]
      };
    },
    async selectEvidence({ candidates }) {
      return [{
        passageId: candidates[0].id,
        supports: ['新版本行为发生变化'],
        contradicts: [],
        relevance: 0.95,
        sourceRole: 'primary_candidate'
      }];
    },
    async assessGaps({ tracks }) {
      return {
        trackResults: tracks.map((track) => ({
          trackId: track.id,
          status: track.status,
          reason: '',
          missingEvidence: track.gaps || [],
          followUpQueries: []
        })),
        conflicts: [],
        shouldReplan: false
      };
    },
    async writeReportDraft({ tracks, evidence }) {
      writerCalls += 1;
      const invalid = overrides.alwaysInvalid || (overrides.invalidFirst && writerCalls === 1);
      return {
        title: '研究结论',
        sections: tracks.map((track) => ({
          trackId: track.id,
          heading: track.question,
          claims: [{
            type: 'external_practice',
            text: '新版本行为发生变化。',
            evidenceIds: invalid
              ? ['E99']
              : [evidence.find((item) => item.trackId === track.id)?.id].filter(Boolean)
          }]
        })),
        limitations: tracks.filter((track) => track.status !== 'answered').map((track) => ({
          trackId: track.id,
          text: '当前证据未覆盖全部问题。'
        }))
      };
    }
  };
  return {
    store,
    worker: createResearchNewWorker({ store, search, sourceReader, aiService, now: () => 123 }),
    writerCalls: () => writerCalls
  };
}

test('单轮 Research New 从计划、搜索、正文、Evidence 收敛到可引用报告', async (t) => {
  const { store, worker } = fixture(t);
  const created = store.create({ question: '比较新旧版本', mode: 'web' });
  const completed = await worker.enqueue(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultQuality, 'sufficient');
  assert.equal(completed.sources[0].readerKind, 'web_page');
  assert.equal(completed.evidence[0].id, 'E1');
  assert.match(completed.report, /\[E1\]/u);
  assert.equal(completed.budget.searchCalls, 1);
  assert.equal(completed.budget.sourcesRead, 1);
});

test('结构化草稿引用未知 Evidence 时触发一次 Writer 重试', async (t) => {
  const { store, worker, writerCalls } = fixture(t, { invalidFirst: true });
  const created = store.create({ question: '比较新旧版本', mode: 'web' });
  const completed = await worker.enqueue(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(writerCalls(), 2);
  assert.equal(completed.budget.writerAttempts, 2);
});

test('Writer 两次都无法通过验证时 Run 失败，不生成兜底报告', async (t) => {
  const { store, worker, writerCalls } = fixture(t, { alwaysInvalid: true });
  const created = store.create({ question: '比较新旧版本', mode: 'web' });
  const failed = await worker.enqueue(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(writerCalls(), 2);
  assert.equal(failed.report, '');
  assert.match(failed.error, /报告验证失败/u);
});

test('零 Evidence 时不调用普通 Writer，以 completed + insufficient 诚实交付', async (t) => {
  let writerCalls = 0;
  const aiService = {
    async plan() {
      return {
        brief: { objective: '调查问题', requiredQuestions: ['问题有什么可靠结论？'] },
        tracks: [{
          id: 'track-1', question: '问题有什么可靠结论？', searchQueries: ['问题 可靠资料'],
          evidenceRequirements: ['直接证据'], status: 'pending', gaps: []
        }]
      };
    },
    async selectEvidence() { return []; },
    async assessGaps({ tracks }) {
      return {
        trackResults: tracks.map((track) => ({
          trackId: track.id, status: track.status, reason: '',
          missingEvidence: track.gaps || [], followUpQueries: []
        })),
        conflicts: [], shouldReplan: false
      };
    },
    async writeReportDraft() { writerCalls += 1; throw new Error('零证据不应调用 Writer'); }
  };
  const { store, worker } = fixture(t, { aiService });
  const created = store.create({ question: '调查问题', mode: 'web' });
  const completed = await worker.enqueue(created.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultQuality, 'insufficient');
  assert.equal(writerCalls, 0);
  assert.doesNotMatch(completed.report, /\[E\d+\]/u);
  assert.match(completed.report, /证据不足/u);
  assert.match(completed.report, /问题有什么可靠结论/u);
});

test('启动恢复从最近完整 reporting checkpoint 继续，不重复检索', async (t) => {
  const { store, worker } = fixture(t);
  const created = store.create({ question: '恢复研究', mode: 'web' });
  const running = store.claim(created.id);
  const source = {
    id: 'source-track-1', trackId: 'track-1', origin: 'web', title: '官方发布说明',
    url: 'https://example.com/release', sourceKind: 'official_docs', content: '正文证据',
    contentHash: 'source-hash', readerKind: 'web_page', contentLevel: 'full_text', fetchedAt: 123
  };
  const evidence = {
    id: 'E1', trackId: 'track-1', sourceId: source.id, origin: 'web', passage: '正文证据',
    passageHash: 'passage-hash', supports: ['版本变化'], contradicts: [], relevance: 1,
    sourceRole: 'primary_candidate', contentLevel: 'full_text'
  };
  store.checkpoint(created.id, running.attempt, {
    stage: 'reporting',
    progress: 70,
    brief: { objective: '恢复研究', requiredQuestions: ['发生了什么变化？'] },
    tracks: [{ id: 'track-1', question: '发生了什么变化？', status: 'answered', gaps: [] }],
    sources: [source],
    evidence: [evidence]
  });
  await worker.resume();
  const completed = store.get(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.budget.searchCalls, 0);
});

test('取消会中止进行中的调用，迟到结果不能覆盖 cancelled', async (t) => {
  let searchStarted;
  const started = new Promise((resolve) => { searchStarted = resolve; });
  const search = {
    async buildWorkspaceContext() { return []; },
    async search({ signal }) {
      searchStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  };
  const { store, worker } = fixture(t, { search });
  const created = store.create({ question: '调查现状', mode: 'web' });
  const running = worker.enqueue(created.id);
  await started;
  worker.cancel(created.id);
  const cancelled = await running;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(store.get(created.id).status, 'cancelled');
});

test('Gap Assessment 只补搜未完成 Track 一次并合并新增 Evidence', async (t) => {
  const queries = [];
  let selectionCalls = 0;
  let assessmentCalls = 0;
  const search = {
    async buildWorkspaceContext() { return []; },
    async search({ trackId, query }) {
      queries.push(query);
      return {
        webStatus: 'available',
        sources: [{
          id: `source-${trackId}-${queries.length}`,
          trackId,
          origin: 'web',
          title: queries.length === 1 ? '搜索摘要' : '官方完整说明',
          url: `https://example.com/source-${queries.length}`,
          snippet: '相关摘要',
          query,
          sourceKind: queries.length === 1 ? 'public_web' : 'official_docs'
        }]
      };
    }
  };
  const sourceReader = {
    async read(source) {
      return {
        document: {
          id: source.id,
          title: source.title,
          content: source.query === '初始查询'
            ? '这是一段只能提供有限线索的搜索摘要内容，尚不足以回答完整问题。'
            : '官方完整说明明确给出缺失事实，并足以回答原研究问题。',
          contentHash: `hash-${source.id}`,
          readerKind: source.query === '初始查询' ? 'search_snippet' : 'provider_content',
          contentLevel: source.query === '初始查询' ? 'snippet' : 'full_text',
          fetchedAt: 123
        },
        failure: null
      };
    }
  };
  const aiService = {
    async plan() {
      return {
        brief: { objective: '研究问题', requiredQuestions: ['缺失事实是什么？'] },
        tracks: [{
          id: 'track-1', question: '缺失事实是什么？', searchQueries: ['初始查询'],
          evidenceRequirements: ['直接证据'], status: 'pending', gaps: []
        }]
      };
    },
    async selectEvidence({ candidates }) {
      selectionCalls += 1;
      return [{
        passageId: candidates[0].id,
        supports: [selectionCalls === 1 ? '有限线索' : '缺失事实'],
        contradicts: [], relevance: 1, sourceRole: 'primary_candidate'
      }];
    },
    async assessGaps({ tracks }) {
      assessmentCalls += 1;
      return {
        trackResults: tracks.map((track) => ({
          trackId: track.id,
          status: assessmentCalls === 1 ? 'partial' : 'answered',
          reason: assessmentCalls === 1 ? '需要官方完整说明' : '缺口已补齐',
          missingEvidence: assessmentCalls === 1 ? ['官方完整说明'] : [],
          followUpQueries: assessmentCalls === 1 ? ['补充查询'] : []
        })),
        conflicts: [],
        shouldReplan: assessmentCalls === 1
      };
    },
    async writeReportDraft() {
      return {
        title: '研究结论',
        sections: [{
          trackId: 'track-1', heading: '缺失事实', claims: [{
            type: 'external_practice', text: '缺失事实已由补充证据回答。', evidenceIds: ['E2']
          }]
        }],
        limitations: []
      };
    }
  };
  const { store, worker } = fixture(t, { search, sourceReader, aiService });
  const created = store.create({ question: '研究问题', mode: 'web' });
  const completed = await worker.enqueue(created.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultQuality, 'sufficient');
  assert.deepEqual(queries, ['初始查询', '补充查询']);
  assert.equal(assessmentCalls, 2);
  assert.equal(completed.budget.roundsUsed, 2);
  assert.equal(completed.budget.searchCalls, 2);
  assert.equal(completed.evidence.length, 2);
  assert.equal(completed.tracks[0].status, 'answered');
  assert.equal(completed.diagnostics.gapAssessments.length, 2);
});

test('初轮为 targeted replan 保留两次 Reader 额度而不扩大总预算', async (t) => {
  const queries = [];
  let assessmentCalls = 0;
  const tracks = Array.from({ length: 5 }, (_, index) => ({
    id: `track-${index + 1}`,
    question: `问题 ${index + 1}`,
    searchQueries: [`初始查询 ${index + 1}`],
    evidenceRequirements: ['直接证据'],
    status: 'pending',
    gaps: []
  }));
  const search = {
    async buildWorkspaceContext() { return []; },
    async search({ trackId, query }) {
      queries.push(query);
      return {
        webStatus: 'available',
        sources: [1, 2].map((number) => ({
          id: `source-${trackId}-${query}-${number}`,
          trackId,
          origin: 'web',
          title: `来源 ${number}`,
          url: `https://example.com/${encodeURIComponent(trackId)}-${queries.length}-${number}`,
          snippet: '相关摘要',
          query,
          sourceKind: 'official_docs'
        }))
      };
    }
  };
  const sourceReader = {
    async read(source) {
      return {
        document: {
          id: source.id,
          title: source.title,
          content: '这是一段足够长且可以形成直接证据的官方正文内容。',
          contentHash: `hash-${source.id}`,
          readerKind: 'provider_content',
          contentLevel: 'full_text',
          fetchedAt: 123
        },
        failure: null
      };
    }
  };
  const aiService = {
    async plan() {
      return { brief: { objective: '多 Track 研究', requiredQuestions: tracks.map((item) => item.question) }, tracks };
    },
    async selectEvidence({ candidates }) {
      return candidates.slice(0, 1).map((candidate) => ({
        passageId: candidate.id,
        supports: ['直接证据'],
        contradicts: [],
        relevance: 1,
        sourceRole: 'primary_candidate'
      }));
    },
    async assessGaps({ tracks: assessedTracks }) {
      assessmentCalls += 1;
      return {
        trackResults: assessedTracks.map((track) => ({
          trackId: track.id,
          status: track.id === 'track-1' && assessmentCalls === 1 ? 'partial' : 'answered',
          reason: '',
          missingEvidence: track.id === 'track-1' && assessmentCalls === 1 ? ['补充证据'] : [],
          followUpQueries: track.id === 'track-1' && assessmentCalls === 1 ? ['补充查询'] : []
        })),
        conflicts: [],
        shouldReplan: assessmentCalls === 1
      };
    },
    async writeReportDraft({ tracks: reportTracks, evidence }) {
      return {
        title: '研究结论',
        sections: reportTracks.map((track) => ({
          trackId: track.id,
          heading: track.question,
          claims: [{
            type: 'external_practice',
            text: '当前 Track 已形成直接证据。',
            evidenceIds: [evidence.find((item) => item.trackId === track.id)?.id].filter(Boolean)
          }]
        })),
        limitations: []
      };
    }
  };
  const { store, worker } = fixture(t, { search, sourceReader, aiService });
  const created = store.create({ question: '多 Track 研究', mode: 'web' });
  const completed = await worker.enqueue(created.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.budget.roundsUsed, 2);
  assert.equal(completed.budget.sourcesRead, 10);
  assert.equal(completed.budget.maxSourcesRead, 10);
  assert.equal(queries.length, 6);
  assert.equal(queries.at(-1), '补充查询');
});
