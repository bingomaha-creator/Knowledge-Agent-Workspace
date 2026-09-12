/**
 * Phase 1 Harness shadow 的 Worker 边界集成测试。
 *
 * 验证（Spec research-harness §8.3/§12 Phase 1）：
 * - 完成契约 verdict 真实计算并持久化，但执行链忽略它（mode 恒为 shadow）；
 * - 最小 RunBudget：webSearchCalls 在 Search service 的 Provider 调用边界计数
 *   （local 不计、发起后抛错仍计、重启/重试后累计），经由 onWebSearchAttempt 观察者；
 * - 错误分类持久化，失败语义不变；Phase 0 两个信号在真实管线可观测；
 * - shadow 写入携带 attempt 守卫，旧 attempt 迟到写被拒绝。
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

const LOCAL_SOURCES = {
  子问题一: {
    local: [
      { id: 'l1', title: '本地资料一', snippet: '子问题一的本地资料答案，内容足够长以通过段落筛选并参与证据装配与引用。' },
      { id: 'l2', title: '本地资料二', snippet: '子问题一的另一条本地资料答案，同样足够长以通过筛选进入证据包。' }
    ]
  },
  子问题二: {
    local: [
      { id: 'l3', title: '本地资料三', snippet: '子问题二的本地资料答案，长度与措辞保证能够通过筛选进入候选池。' },
      { id: 'l4', title: '本地资料四', snippet: '子问题二的另一条本地资料答案，保证证据数量达到 shadow 阈值要求。' }
    ]
  }
};

function fixtureAdapters({ searchResults = WEB_SOURCES, writerMode = 'model', failSearch = false } = {}) {
  return {
    planResearch: async () => ({
      planner: 'fixture',
      subquestions: SUBQUESTIONS,
      diagnostics: { mode: 'fixture', status: 'success', durationMs: 0, inputTokens: 0, outputTokens: 0 }
    }),
    searchSources: async ({ query, searchMode, onWebSearchAttempt }) => {
      if (failSearch) {
        // 检索在 Provider 发起前抛出：不触发观察者，对应"Provider 未调用不计数"。
        throw Object.assign(new Error('fixture 检索失败'), { code: 'UPSTREAM_ERROR' });
      }
      const entry = searchResults[query];
      const web = Array.isArray(entry) ? entry : (entry?.web || []);
      const local = Array.isArray(entry) ? [] : (entry?.local || []);
      // 模拟 search service 的 Provider 调用边界：非 local 模式先通知观察者再返回结果。
      if (searchMode !== 'local' && typeof onWebSearchAttempt === 'function') {
        try {
          onWebSearchAttempt({ query });
        } catch { /* 观察者异常不影响检索 */ }
      }
      const webSearchStatus = (!Array.isArray(entry) && entry?.webSearchStatus)
        ?? (searchMode === 'local' ? 'not_requested' : (web.length ? 'available' : 'unavailable'));
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

test('shadow 健康路径（local）：来源均为项目资料，契约 complete，Provider 调用为 0', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({ searchResults: LOCAL_SOURCES })
    });
    const created = store.create({ question: '本地健康研究', searchMode: 'local', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed', '执行语义不变：正常收敛 completed');
    const budget = store.getRunBudget(finalTask.id);
    assert.ok(budget, 'RunBudget 已持久化');
    assert.equal(budget.webSearchCalls, 0, 'local 模式不发起 Provider 调用，不计数');
    assert.equal(budget.targetedReplans.used, 0, 'Phase 1 不执行 replan，计数恒为 0');
    assert.equal(budget.writerTokens.input, 120, 'writer token 计数来自写作诊断');

    const contract = store.getContractChecks(finalTask.id);
    assert.ok(contract, '契约 verdict 已持久化');
    assert.equal(contract.mode, 'shadow', '执行链只能以 shadow 口径记录');
    assert.equal(contract.nextAction, 'complete');
    const byId = Object.fromEntries(contract.checks.map((item) => [item.id, item]));
    assert.equal(byId['writer-output-accepted'].passed, true);
    assert.equal(byId['writer-input-boundary'].passed, null, 'Writer 输入边界在 Phase 1 恒为 not_evaluated');
    assert.equal(byId['source-provenance'].passed, null, 'local 模式无外部来源，provenance 不适用');
    for (const item of contract.checks) {
      assert.ok(item.artifactRefs?.length, `${item.id} 必须携带 artifactRefs`);
    }
    assert.deepEqual(contract.notEvaluableRequired, ['writer-input-boundary']);

    // local 模式台账：条目存在，但无外部来源 → 无 provenance 升级
    const ledger = store.getEvidenceLedger(finalTask.id);
    assert.ok(ledger, 'local 模式 shadow 台账同样持久化');
    assert.ok(ledger.entries.length > 0);
    assert.ok(ledger.entries.every((item) => item.provenanceAfter === item.provenanceBefore),
      'local 来源不涉及 provenance 升级');
    assert.ok(ledger.entries.every((item) => item.sourceChannel === 'local'));
  } finally {
    cleanup();
  }
});

test('shadow web 路径：来源未经一手验证（reader_obtained 不升级）→ 建议不因此改变；调用经观察者累计', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({ store, concurrency: 1, ...fixtureAdapters() });
    const created = store.create({ question: '外部检索研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed');
    const budget = store.getRunBudget(finalTask.id);
    assert.equal(budget.webSearchCalls, 2, '两个子问题各发起一次 Provider 调用（观察者累计）');

    const contract = store.getContractChecks(finalTask.id);
    const byId = Object.fromEntries(contract.checks.map((item) => [item.id, item]));
    assert.equal(byId['source-provenance'].passed, false, 'example.org 未通过一手验证（candidate_primary 也不算）');
    assert.equal(contract.nextAction, 'complete', 'provenance 是观察指标：缺口的补救是 Reader 验证而非补检索，不机械 replan');

    // Evidence Ledger shadow 双写：旧路径 Writer 输入不变；attestation 与 provenance 分离
    const ledger = store.getEvidenceLedger(finalTask.id);
    assert.ok(ledger, 'shadow 模式下台账已持久化');
    assert.equal(ledger.ledgerVersion, 1);
    const succeeded = ledger.entries.filter((item) => item.reading.status === 'succeeded');
    assert.ok(succeeded.length > 0, '经 fixture Adapter 成功读取的来源存在');
    for (const item of succeeded) {
      assert.equal(item.readerAttestation.level, 'reader_obtained',
        'provider_raw/GitHub 读取成功只是 reader_obtained，不得自动升级');
      assert.equal(item.provenanceAfter, item.provenanceBefore, '无显式 verified attestation 时 provenance 保持原值');
      assert.equal(item.provenanceTransition, null);
    }
    const rejected = ledger.entries.filter((item) => item.screening.status === 'rejected');
    assert.ok(rejected.every((item) => item.provenanceTransition.reason.startsWith('screening_rejected:')),
      '筛选拒绝的来源记录拒绝原因且不升级 provenance');
    // citation 终态由 verifying 的 referencedCitationIds 收敛：被报告实际引用的为 cited
    const cited = ledger.entries.filter((item) => item.citation.status === 'cited');
    assert.ok(cited.length > 0, '报告实际引用的来源收敛为 cited');
    assert.ok(cited.every((item) => item.citation.status !== 'writer_selected'));

    // would-be diff 是读取资格差异诊断
    assert.ok(ledger.diff, '读取资格差异诊断已持久化');
    assert.equal(ledger.diff.mode, 'shadow');
    assert.equal(ledger.diff.diagnostic, 'reading_eligibility');
    assert.ok(Array.isArray(ledger.diff.ledgerWouldIncludeCitationIds));
    assert.ok(Array.isArray(ledger.diff.ledgerExcludedButWriterUsed));
    assert.ok(contract.artifactRefs === undefined, 'artifactRefs 挂在 check 上而非 verdict 上');
    assert.ok(contract.checks.every((item) => item.artifactRefs?.length));
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
      ...fixtureAdapters({
        searchResults: {
          子问题一: { webSearchStatus: 'available' },
          子问题二: { webSearchStatus: 'available' }
        }
      })
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
    assert.equal(byId['writer-output-accepted'].passed, null, 'Writer 未尝试时该检查以 not_evaluated 恒在');
    assert.equal(store.getRunBudget(created.id)?.webSearchCalls, 2, 'Provider 已被调用（返回空），计数如实');
  } finally {
    cleanup();
  }
});

test('Provider 发起后抛错：调用已发生仍计数，失败语义不变且错误分类持久化', async () => {
  const { store, cleanup } = tempStore();
  try {
    const adapters = fixtureAdapters();
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...adapters,
      searchSources: async ({ onWebSearchAttempt }) => {
        // 模拟"Provider 请求已发起，之后上游抛错"：观察者先于异常触发。
        if (typeof onWebSearchAttempt === 'function') {
          onWebSearchAttempt({ query: 'thrown' });
        }
        throw Object.assign(new Error('fixture 上游抛错'), { code: 'UPSTREAM_ERROR' });
      }
    });
    const created = store.create({ question: '调用后抛错研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'failed', '失败语义不变');
    assert.equal(store.getRunBudget(created.id)?.webSearchCalls, 2,
      '两个子问题的 Provider 请求都已发起（观察者先于异常触发），调用已发生即计数');
    const errors = store.listRunErrors(created.id);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].category, 'upstream');
    assert.equal(errors[0].retryable, true);
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
    assert.equal(store.getRunBudget(finalTask.id)?.webSearchCalls, 0, 'Provider 未被调用，不计数');
    assert.ok(store.getRunBudget(finalTask.id), '失败路径同样持久化预算快照');
  } finally {
    cleanup();
  }
});

test('重试后 webSearchCalls 保持累计：失败 attempt 未调 Provider 不计数，新 attempt 正确累加', async () => {
  const { store, cleanup } = tempStore();
  try {
    const failingWorker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({ failSearch: true })
    });
    const created = store.create({ question: '重试累计研究', searchMode: 'web', knowledgeBaseIds: [] });
    const failedTask = await failingWorker.enqueue(created.id);
    assert.equal(failedTask.status, 'failed');
    assert.equal(store.getRunBudget(created.id)?.webSearchCalls, 0,
      '检索在 Provider 调用前抛出，不得计数');

    // retry：attempt 前进，新 attempt 的 2 次调用累加到同一 Run 的计数上
    assert.ok(store.retry(created.id), 'failed 任务可重试');
    const workingWorker = createResearchWorker({ store, concurrency: 1, ...fixtureAdapters() });
    const finalTask = await workingWorker.enqueue(created.id);
    assert.equal(finalTask.status, 'completed');
    assert.ok(Number(finalTask.attempt) >= 2, 'retry 后 attempt 前进');
    assert.equal(store.getRunBudget(created.id)?.webSearchCalls, 2,
      '新 attempt 的调用累计（SQL 自增），不是覆盖也不是清零');

    // 旧 attempt 的迟到写入被 attempt 守卫拒绝
    const staleAttempt = Number(finalTask.attempt) - 1;
    assert.equal(store.addRunBudgetWebSearchCalls(created.id, 99, { attempt: staleAttempt }), false);
    assert.equal(store.getRunBudget(created.id)?.webSearchCalls, 2, '迟到写入不得污染累计值');
  } finally {
    cleanup();
  }
});

test('Evidence Ledger 开关：off 完全跳过，primary 未过门槛前直接抛错', async () => {
  const { store, cleanup } = tempStore();
  try {
    const created = store.create({ question: 'off 模式研究', searchMode: 'web', knowledgeBaseIds: [] });
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      evidenceLedgerMode: 'off',
      ...fixtureAdapters()
    });
    const finalTask = await worker.enqueue(created.id);
    assert.equal(finalTask.status, 'completed');
    assert.equal(store.getEvidenceLedger(created.id), null, 'off 模式不写台账');
    assert.throws(
      () => createResearchWorker({ store, concurrency: 1, evidenceLedgerMode: 'primary', ...fixtureAdapters() }),
      /Phase 2A 仅开放 shadow/,
      'primary 未通过双写验收门槛前必须 fail closed'
    );
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

// —— 真实 Worker 顺序故障注入（Codex Phase 2A 修正第 6 点）——
// 通过包装 store 注入 Ledger 写入故障，验证：组合提交失败不会先推进主快照；
// shadow 降级继续执行时 artifacts.ledgerShadow 明确标记缺失（后续验收排除该 Run）。

function withFaultyLedgerStore(realStore, fault) {
  return {
    ...realStore,
    commitRunningStageWithLedger: (id, patch, options, ledger) => {
      if (fault === 'extracting' && ledger?.type === 'replace') {
        throw Object.assign(new Error('injected extracting ledger fault'), { code: 'INJECTED_FAULT' });
      }
      if (fault === 'skip-replace') {
        // 真实化注入（Codex Phase 2A 修正第 4 点）：主快照真实提交（updateRunning），
        // 但跳过 Ledger 写入——模拟"组合提交只完成一半"的故障；随后 verifying 的
        // citations finalize 会命中"空台账 + 非空引用"诊断。
        return ledger?.type === 'replace'
          ? (realStore.updateRunning(id, patch) ? true : false)
          : realStore.commitRunningStageWithLedger(id, patch, options, ledger);
      }
      return realStore.commitRunningStageWithLedger(id, patch, options, ledger);
    }
  };
}

test('故障注入：extracting Ledger 写入失败 → 不先推进主快照，降级后 artifacts 明确标记缺失', async () => {
  const { store, cleanup } = tempStore();
  try {
    const faultyStore = withFaultyLedgerStore(store, 'extracting');
    const worker = createResearchWorker({
      store: faultyStore,
      concurrency: 1,
      ...fixtureAdapters()
    });
    const created = faultyStore.create({ question: 'extracting 故障注入', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed', 'shadow 降级继续执行');
    assert.equal(finalTask.artifacts.ledgerShadow?.status, 'failed',
      'artifacts 必须明确标记 ledger shadow 缺失，供后续验收排除该 Run');
    assert.match(finalTask.artifacts.ledgerShadow.reason, /LEDGER_COMMIT_FAILED/);
    assert.equal(store.getEvidenceLedger(created.id), null, '台账写入未成功，不得表现成 Ledger 完整');
    // 旧实现会先 persistStage 再组合提交：主快照早已推进且无降级标记。降级标记的
    // 存在同时证明写入只发生一次（fallback 路径），不存在"先推进、后补台账"的双写。
    assert.ok(finalTask.artifacts.evidence?.length, '证据路径（旧路径）不受影响，Writer 输入照常');
  } finally {
    cleanup();
  }
});

test('故障注入：verifying finalize 遇空台账 + 非空引用 → 显式失败并降级标记', async () => {
  const { store, cleanup } = tempStore();
  try {
    const faultyStore = withFaultyLedgerStore(store, 'skip-replace');
    const worker = createResearchWorker({
      store: faultyStore,
      concurrency: 1,
      ...fixtureAdapters()
    });
    const created = faultyStore.create({ question: 'finalize 故障注入', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(finalTask.status, 'completed', 'shadow 降级继续执行');
    assert.equal(finalTask.artifacts.ledgerShadow?.status, 'failed');
    assert.match(finalTask.artifacts.ledgerShadow.reason, /LEDGER_MISSING_FOR_FINALIZE/,
      '空台账 + 非空引用的 finalize 失败必须带明确诊断');
    assert.equal(store.getEvidenceLedger(created.id), null);
  } finally {
    cleanup();
  }
});

test('成功路径不写 ledgerShadow 失败标记：不得表现成 Ledger 不完整', async () => {
  const { store, cleanup } = tempStore();
  try {
    const worker = createResearchWorker({ store, concurrency: 1, ...fixtureAdapters() });
    const created = store.create({ question: '正常路径', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);
    assert.equal(finalTask.status, 'completed');
    assert.equal(finalTask.artifacts.ledgerShadow, undefined,
      '成功路径不得携带 ledgerShadow 失败标记');
    assert.ok(store.getEvidenceLedger(created.id));
  } finally {
    cleanup();
  }
});

// —— 组合提交布尔 false 的竞态语义（Codex Phase 2A 修正第 1 点）——

test('组合提交返回 false（取消竞态）：重读 Run 按竞态语义停止，不盲目 fallback 写入', async () => {
  const { store, cleanup } = tempStore();
  try {
    let falseReturned = false;
    const faultyStore = {
      ...store,
      commitRunningStageWithLedger: (id, patch, options, ledger) => {
        if (ledger?.type === 'replace') {
          // 模拟守卫拒绝竞态：任务已在组合提交前被取消，返回 false
          store.cancel(id);
          falseReturned = true;
          return false;
        }
        return store.commitRunningStageWithLedger(id, patch, options, ledger);
      }
    };
    const worker = createResearchWorker({ store: faultyStore, concurrency: 1, ...fixtureAdapters() });
    const created = faultyStore.create({ question: 'false 返回竞态', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);

    assert.equal(falseReturned, true);
    assert.equal(finalTask.status, 'cancelled', '取消竞态按现有语义停止');
    assert.equal(finalTask.artifacts.ledgerShadow, undefined,
      '竞态停止不得写 ledgerShadow 降级标记（那是非竞态故障专属）');
    assert.equal(store.getEvidenceLedger(created.id), null);
  } finally {
    cleanup();
  }
});

test('合法零证据的空台账与未写入台账不再共用 null 语义（meta 消歧）', async () => {
  const { store, cleanup } = tempStore();
  try {
    // 从未写入的任务：getEvidenceLedger 保持 null
    const untouched = store.create({ question: '未写入研究', searchMode: 'web', knowledgeBaseIds: [] });
    assert.equal(store.getEvidenceLedger(untouched.id), null, '未写入台账必须返回 null');

    // 零证据 run：meta.status='empty'，entries 为合法空集（不伪造 evidence entry）
    const worker = createResearchWorker({
      store,
      concurrency: 1,
      ...fixtureAdapters({
        searchResults: {
          子问题一: { webSearchStatus: 'available' },
          子问题二: { webSearchStatus: 'available' }
        }
      })
    });
    const created = store.create({ question: '零证据研究', searchMode: 'web', knowledgeBaseIds: [] });
    const finalTask = await worker.enqueue(created.id);
    assert.equal(finalTask.status, 'completed');
    const ledger = store.getEvidenceLedger(created.id);
    assert.ok(ledger, '零证据但已写入的台账不得返回 null');
    assert.deepEqual(ledger.entries, []);
    assert.equal(ledger.meta.status, 'empty');
    assert.equal(ledger.meta.entryCount, 0);
    assert.equal(ledger.diff.diagnostic, 'reading_eligibility');
    assert.equal(ledger.diff.counts.actual, 0, '零证据时差异诊断为全零，而非缺失');
  } finally {
    cleanup();
  }
});
