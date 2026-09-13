/**
 * Phase 0 评测执行器：把固定 case 跑进真实的 createResearchWorker 状态机，
 * 只注入 planner / search / reader / writer 四个 adapter（Spec 保持不动的注入 seam）。
 *
 * fixture 模式的四个 adapter 全部是确定性内存实现，不发起任何网络或模型调用；
 * live 模式由 research-eval-live.js 注入真实 Qwen / 博查 / Reader 适配器。
 * Store 使用一次性临时 SQLite 文件，与开发数据库完全隔离。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchStore } from '../../research-store.js';
import { createResearchWorker } from '../../research-worker.js';
import { assessResearchQuality } from '../../research-quality.js';
import { evaluateCompletionContract } from '../../research-completion-policy.js';
import { computeCaseMetrics } from './metrics.js';

/**
 * 从 case 的 fixtures 构造确定性 adapter。
 *
 * fixtures.search 以子问题 searchQuery 为 key；fixtures.read 以来源 id 为 key，
 * { text, readerKind } 表示读取成功、{ fail: true } 表示读取失败（验证 snippet
 * 回退与 Reader 失败诊断）；fixtures.writer 为 'faithful'（逐条引用证据）或
 * 'invalid_citations'（输出非法引用编号，验证 writer 降级路径）。
 */
export function createFixtureAdapters(testCase) {
  return (counters) => {
    const fixtures = testCase.fixtures || {};
    const searchByQuery = fixtures.search || {};
    const readBySource = fixtures.read || {};

    return {
      planResearch: async () => {
        counters.plannerCalls += 1;
        return {
          planner: 'fixture',
          subquestions: fixtures.plan.subquestions,
          diagnostics: {
            mode: 'fixture',
            status: 'success',
            reasonCode: '',
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0
          }
        };
      },

      searchSources: async ({ query, searchMode }) => {
        counters.searchCalls += 1;
        if (searchMode !== 'local') counters.webSearchRequests += 1;
        const entry = searchByQuery[query] || {};
        const payload = { local: entry.local || [], web: entry.web || [] };
        const status = entry.webSearchStatus
          ?? (searchMode === 'local' ? 'not_requested' : payload.web.length ? 'available' : 'unavailable');
        if (searchMode !== 'local' && status !== 'available') counters.webSearchDegradedQueries += 1;
        return { ...payload, webSearchStatus: status };
      },

      readResearchSources: async ({ sources }) => {
        const documents = [];
        const failures = [];
        for (const source of sources) {
          counters.readAttempts += 1;
          const read = readBySource[source.id];
          if (read?.fail) {
            counters.readerFailures += 1;
            failures.push({
              sourceId: source.id,
              code: read.code || 'READ_FAILED',
              message: read.message || 'fixture 读取失败',
              retryable: false
            });
            continue;
          }
          if (read?.text) {
            counters.readerSuccesses += 1;
            documents.push({
              sourceId: source.id,
              content: read.text,
              readerKind: read.readerKind || 'fixture_fulltext'
            });
          }
        }
        return {
          documents,
          failures,
          diagnostics: {
            selectedSourceCount: sources.length,
            readSourceCount: documents.length,
            failedSourceCount: failures.length,
            durationMs: 0
          }
        };
      },

      writeResearchReport: async ({ evidence }) => {
        counters.writerCalls += 1;
        const lines = (fixtures.writer === 'invalid_citations')
          ? evidence.map((item) => `- ${item.claim} [99]`)
          : evidence.map((item) => `- ${item.claim} [${item.citationNumber}]`);
        return {
          draftReport: [
            '## 研究结论',
            ...lines,
            '',
            '## 局限',
            '以上结论仅基于本次检索到的证据，超出证据范围的问题未给出结论。'
          ].join('\n'),
          diagnostics: {
            mode: 'fixture',
            status: 'success',
            reasonCode: '',
            inputTokens: 0,
            outputTokens: 0
          }
        };
      }
    };
  };
}

/**
 * 在一次性 SQLite 上执行一个 case，返回该 case 的基线指标。
 * Worker/Store 均为生产实现；取消、续跑等语义因此也在评测路径上被真实执行。
 * includeLedger=true 时额外返回台账快照（would-be Pack 门槛验证用）。
 */
export async function runEvalCase({ testCase, adapters, mode, dbPath, includeLedger = false }) {
  if (typeof adapters !== 'function') throw new TypeError('adapters 必须是 (counters) => workerDeps 工厂');
  const store = createResearchStore(dbPath);
  try {
    const counters = {
      plannerCalls: 0,
      writerCalls: 0,
      searchCalls: 0,
      webSearchRequests: 0,
      webSearchDegradedQueries: 0,
      localSearchCalls: 0,
      readAttempts: 0,
      readerSuccesses: 0,
      readerFailures: 0
    };
    const worker = createResearchWorker({ store, concurrency: 1, ...adapters(counters) });
    const created = store.create({
      question: testCase.question,
      searchMode: testCase.searchMode,
      knowledgeBaseIds: testCase.knowledgeBaseIds || []
    });
    const startedAt = Date.now();
    const task = await worker.enqueue(created.id);
    const latencyMs = Date.now() - startedAt;
    const metrics = computeCaseMetrics({ testCase, task, latencyMs, counters, mode });
    if (!includeLedger) return { metrics };
    return {
      metrics,
      task,
      ledger: store.getEvidenceLedger(created.id)
    };
  } finally {
    store.close();
  }
}

/**
 * 让指定 Evidence Pack（旧路径或 Ledger would-be）经真实 Worker 的交付管线，
 * 从 outlining/writing/verifying 阶段恢复运行（Codex 修正：利用 extracting
 * 完成后的持久化 checkpoint，将 Pack 原样注入 artifacts，不再重新检索/装配，
 * 也不复制 Worker 语义）。
 *
 * 流程：
 * - Phase A：真实 Worker 按 case fixture 完整运行（planning→…→completed），
 *   取得 extracting 完成后的持久化 checkpoint（citations/evidence/sources/
 *   reading/plan 等元数据齐全）。
 * - Phase B：新建一次性 Store，将 checkpoint artifacts 中的 citations/evidence
 *   原样替换为指定 Pack（编号/claims/passages/subquestionId/readerKind/来源
 *   元数据逐项保留），任务置为 outlining 阶段的 queued 状态，再经真实
 *   Worker 的 claim→恢复→writing→verifying→completed 收敛。
 * - Writer 调用边界断言：citations（id/顺序）与 evidence（claims/passages）
 *   必须与指定 Pack 逐项一致；有证据 case 的 Writer 输入不得为空，只有原本
 *   零证据 case 才允许空集。
 * - Writer 行为忠实传入（writerMode：faithful | invalid_citations）——
 *   invalid-citations 用例真实验证拒绝与确定性 fallback 重建。
 *
 * 返回最终 task 快照与 shadow CompletionContract verdict（质量对比用）。
 * 语义支持率等无法离线评估的指标显式 not_evaluated（Policy 已输出 null）。
 */
export async function runPackThroughDelivery({ testCase, pack, writerMode = 'faithful' }) {
  assert.ok(Array.isArray(pack.citations), 'pack.citations 必须是数组');
  assert.ok(Array.isArray(pack.evidence), 'pack.evidence 必须是数组');

  // —— Phase A：真实 Worker 完整运行，取得 extracting 完成后的持久化 checkpoint ——
  const phaseADir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-phase-a-'));
  const storeA = createResearchStore(path.join(phaseADir, 'a.sqlite'));
  let baseArtifacts;
  try {
    const workerA = createResearchWorker({
      store: storeA,
      concurrency: 1,
      ...createFixtureAdapters(testCase)({
        plannerCalls: 0, writerCalls: 0, searchCalls: 0, webSearchRequests: 0,
        webSearchDegradedQueries: 0, localSearchCalls: 0,
        readAttempts: 0, readerSuccesses: 0, readerFailures: 0
      })
    });
    const createdA = storeA.create({
      question: testCase.question,
      searchMode: testCase.searchMode,
      knowledgeBaseIds: testCase.knowledgeBaseIds || []
    });
    const completedA = await workerA.enqueue(createdA.id);
    assert.equal(completedA.status, 'completed', `${testCase.id} Phase A 基线运行必须收敛 completed`);
    baseArtifacts = completedA.artifacts;
  } finally {
    storeA.close();
    fs.rmSync(phaseADir, { recursive: true, force: true });
  }

  // —— Phase B：checkpoint 注入指定 Pack，从 outlining 恢复真实 Worker ——
  const phaseBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-phase-b-'));
  const store = createResearchStore(path.join(phaseBDir, 'b.sqlite'));
  try {
    // Writer 调用边界：记录实际输入，供与指定 Pack 的一致性断言
    let writerInput = null;
    const adapters = createFixtureAdapters(testCase)({});

    const worker = createResearchWorker({
      store,
      concurrency: 1,
      planResearch: adapters.planResearch,
      searchSources: adapters.searchSources,
      readResearchSources: adapters.readResearchSources,
      writeResearchReport: async ({ evidence, citations }) => {
        // Writer 调用边界断言：输入与指定 Pack 逐项一致（id/顺序/claims/passages）
        writerInput = {
          citationIds: (citations || []).map((item) => item.id),
          claims: (evidence || []).map((item) => item.claim),
          passages: (evidence || []).map((item) => item.passage)
        };
        const expectedCitationIds = pack.citations.map((item) => item.id);
        const expectedClaims = pack.evidence.map((item) => item.claim);
        const expectedPassages = pack.evidence.map((item) => item.passage);
        assert.deepEqual(
          writerInput.citationIds, expectedCitationIds,
          'Writer 输入 citations 与指定 Pack 不一致'
        );
        assert.deepEqual(
          writerInput.claims, expectedClaims,
          'Writer 输入 claims 与指定 Pack 不一致'
        );
        assert.deepEqual(
          writerInput.passages, expectedPassages,
          'Writer 输入 passages 与指定 Pack 不一致'
        );
        // 有证据 case 的 Writer 输入不得为空；零证据 case 本就不调用 Writer
        if (pack.citations.length) {
          assert.ok((evidence || []).length > 0, '有证据 case 的 Writer 输入不得为空');
        }
        return adapters.writeResearchReport({ evidence, citations });
      },
      readResearchSources: adapters.readResearchSources,
      resolveResearchRepositories: async () => []
    });

    const created = store.create({
      question: testCase.question,
      searchMode: testCase.searchMode,
      knowledgeBaseIds: testCase.knowledgeBaseIds || []
    });
    // 构造 extracting 完成后的持久化 checkpoint：stage 前进到 outlining，
    // artifacts 中 citations/evidence 原样替换为指定 Pack（其余元数据保留）。
    const checkpointArtifacts = {
      ...baseArtifacts,
      citations: pack.citations,
      evidence: pack.evidence
    };
    store.update(created.id, {
      stage: 'outlining',
      progress: 60,
      artifacts: checkpointArtifacts,
      citations: pack.citations
    });

    const finalTask = await worker.enqueue(created.id);
    const quality = finalTask.artifacts?.quality || {};
    const verdict = evaluateCompletionContract({
      task: finalTask,
      artifacts: finalTask.artifacts || {},
      mode: 'shadow',
      budget: { replans: { used: 0, limit: 1 }, repairs: { used: 0, limit: 1 } }
    });
    return {
      task: finalTask,
      quality,
      verdict,
      writerInputMatchesPack: writerInput !== null || pack.citations.length === 0,
      writerInput,
      citationValidity: finalTask.artifacts?.verification?.valid === true
    };
  } finally {
    store.close();
    fs.rmSync(phaseBDir, { recursive: true, force: true });
  }
}
