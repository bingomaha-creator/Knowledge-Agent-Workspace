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
    async writeReport() {
      writerCalls += 1;
      if (overrides.alwaysInvalid) return '错误引用 [E99]';
      if (overrides.invalidFirst && writerCalls === 1) return '错误引用 [E99]';
      return '# 研究结论\n新版本行为发生变化 [E1]\n\n## 局限与未解决问题\n当前证据来自一份正文。\n\n## 来源\n[E1] 官方发布说明';
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

test('非法引用触发一次 Writer 重试，不使用确定性报告 fallback', async (t) => {
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
