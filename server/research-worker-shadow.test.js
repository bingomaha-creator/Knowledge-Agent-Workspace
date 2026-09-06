/**
 * Phase 1 Harness shadow 的 Worker 边界集成测试。
 *
 * 验证（Spec research-harness §8.3/§12 Phase 1）：
 * - 完成契约 verdict 真实计算并持久化，但执行链忽略它（mode 恒为 shadow）；
 * - 最小 RunBudget 计数持久化，运行中增量更新；
 * - 错误分类持久化，失败语义不变（failed/cancelled 判定与 Phase 0 完全一致）；
 * - Phase 0 信号在真实管线中可观测：非法模型引用 → 建议 repair_report；
 *   零证据 → 建议 replan。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchStore } from './research-store.js';
import { createResearchWorker } from './research-worker.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-shadow-'));
  const store = createResearchStore(path.join(dir, 'shadow.sqlite'));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const SUBQUESTIONS = [
  { id: 'q1', subject: 'A', question: '子问题一是什么？', searchQuery: '子问题一', intent: 'investigation' },
  { id: 'q2', subject: 'B', question: '子问题二是什么？', searchQuery: '子问题二', intent: 'investigation' }
];

const WEB_SOURCES = {
  子问题一: [
    { id: 's1', title: '来源一', url: 'https://example.org/1', snippet: '子问题一的答案内容，足够长以通过段落筛选阈值并保留下来继续参与证据装配。' },
    { id: 's2', title: '来源二', url: 'https://example.org/2', snippet: '子问题一的另一条答案内容，同样足够长以通过相关性筛选并进入候选。' }
  ],
  子问题二: [
    { id: 's3', title: '来源三', url: 'https://example.org/3', snippet: '子问题二的答案内容，长度与措辞保证能够通过相关性筛选进入候选池。' },
    { id: 's4', title: '来源四', url: 'https://example.org/4', snippet: '子问题二的另一条答案内容，保证证据数量达到 shadow 阈值要求。' }
  ]
};

function fixtureAdapters({ searchResults = WEB_SOURCES, writerMode = 'model', failSearch = false } = {}) {
  return {
    planResearch: async () => ({
      planner: 'fixture',
      subquestions: SUBQUESTIONS,
      diagnostics: { mode: 'fixture', status: 'success', durationMs: 0, inputTokens: 0, outputTokens: 0 }
    }),
    searchSources: async ({ query }) => {
      if (failSearch) {
        throw Object.assign(new Error('fixture 检索失败'), { code: 'UPSTREAM_ERROR' });
      }
      // entry 兼容两种形状：来源数组，或带 webSearchStatus/local/web 的对象（零证据 case）。
      const entry = searchResults[query];
      const web = Array.isArray(entry) ? entry : (entry?.web || []);
      const local = Array.isArray(entry) ? [] : (entry?.local || []);
      const webSearchStatus = (!Array.isArray(entry) && entry?.webSearchStatus)
        ?? (web.length ? 'available' : 'unavailable');
      return { local, web, webSearchStatus };
    },
    readResearchSources: async ({ sources }) => ({
      documents: sources.map((source) => ({
        sourceId: source.id,
        content: `${source.snippet}正文补充段落，用于触发正文通道而非搜索摘要回退，并保证段落长度超过筛选阈值，可以被证据装配阶段选中。`,
        readerKind: 'fixture_fulltext'
      })),
      failures: [],
      diagnostics: {
        selectedSourceCount: sources.length,
        readSourceCount: sources.length,
        failedSourceCount: 0,
        durationMs: 0
      }
    }),
    writeResearchReport: async ({ evidence }) => {
      const lines = writerMode === 'invalid_citations'
        ? evidence.map((item) => `- ${item.claim} [99]`)
        : evidence.map((item) => `- ${item.claim} [${item.citationNumber}]`);
      return {
        draftReport: [
          '## 研究范围与方法',
          'fixture 检索。',
          ...lines,
          '## 综合结论、限制与下一步',
          '以上结论仅基于本轮证据。'
        ].join('\n'),
        diagnostics: { mode: 'fixture', status: 'success', inputTokens: 120, outputTokens: 80 }
      };
    }
  };
}

test('shadow 健康路径：契约/预算持久化，completed 语义不变，建议 complete', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({ store, concurrency: 1, ...fixtureAdapters() });
    const created = store.create({ question: '健康路径研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed', '执行语义不变：正常收敛 completed');
    const budget = store.getRunBudget(finalTask.id);
    assert.ok(budget, 'RunBudget 已持久化');
    assert.equal(budget.webSearchCalls, SUBQUESTIONS.length);
    assert.equal(budget.targetedReplans.used, 0, 'Phase 1 不执行 replan，计数恒为 0');
    assert.ok(budget.wallTimeMs >= 0);
    assert.equal(budget.writerTokens.input, 120, 'writer token 计数来自写作诊断');

    const contract = store.getContractChecks(finalTask.id);
    assert.ok(contract, '契约 verdict 已持久化');
    assert.equal(contract.mode, 'shadow', '执行链只能以 shadow 口径记录');
    assert.equal(contract.nextAction, 'complete');
    assert.ok(contract.checks.length > 0);
    const byId = Object.fromEntries(contract.checks.map((item) => [item.id, item]));
    assert.equal(byId['writer-output-accepted'].passed, true);
    assert.equal(byId['writer-input-boundary'].passed, null, 'Writer 输入边界在 Phase 1 恒为 not_evaluated');
    assert.deepEqual(contract.notEvaluableRequired, ['writer-input-boundary']);
  } finally {
    cleanup();
  }
});

test('shadow 信号一：非法模型引用触发 fallback → 建议 repair_report', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({ writerMode: 'invalid_citations' })
    });
    const created = store.create({ question: '非法引用研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed', '降级不改 completed 语义');
    const contract = store.getContractChecks(finalTask.id);
    assert.equal(contract.nextAction, 'repair_report', 'verdict 建议 repair_report');
    const byId = Object.fromEntries(contract.checks.map((item) => [item.id, item]));
    assert.equal(byId['writer-output-accepted'].passed, false);
    assert.equal(byId['writer-output-accepted'].observed.reasonCode, 'invalid_citations');
    assert.deepEqual(contract.deliveryFailures, [], '确定性最终报告的交付检查应当通过');
  } finally {
    cleanup();
  }
});

test('shadow 信号二：零证据 → 建议 replan；不执行任何动作', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({ searchResults: { 子问题一: { webSearchStatus: 'available' }, 子问题二: { webSearchStatus: 'available' } } })
    });
    const created = store.create({ question: '零证据研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed');
    assert.equal(finalTask.resultQuality, 'insufficient');
    const contract = store.getContractChecks(finalTask.id);
    assert.equal(contract.nextAction, 'replan', '零证据 + replan 预算可用 → 建议 replan（不执行）');
    assert.ok(contract.notEvaluableRequired.includes('delivery-mode-consistent'));
    const byId = Object.fromEntries(contract.checks.map((item) => [item.id, item]));
    assert.equal(byId['min-evidence'].passed, false);
    assert.equal(byId['writer-output-accepted'], undefined, 'writer 未尝试时不产生该检查');
  } finally {
    cleanup();
  }
});

test('错误分类持久化：非取消失败写 failed 并记录 upstream 分类，语义不变', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({ failSearch: true })
    });
    const created = store.create({ question: '失败研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'failed', '失败语义不变');
    assert.equal(finalTask.failedStage, 'retrieving');
    const errors = store.listRunErrors(finalTask.id);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].category, 'upstream');
    assert.equal(errors[0].retryable, true);
    assert.ok(store.getRunBudget(finalTask.id), '失败路径同样持久化预算快照');
  } finally {
    cleanup();
  }
});

test('取消路径不产生 shadow 错误记录，cancelled 语义不变', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({ store, concurrency: 1, ...fixtureAdapters() });
    const created = store.create({ question: '取消研究', searchMode: 'web', knowledgeBaseIds: [] });
    const promise = worker.enqueue(created.id);
    worker.cancel(created.id);
    const finalTask = await promise;
    assert.equal(finalTask.status, 'cancelled');
    assert.equal(store.listRunErrors(finalTask.id).length, 0, '取消不是失败，不记录错误分类');
  } finally {
    cleanup();
  }
});
