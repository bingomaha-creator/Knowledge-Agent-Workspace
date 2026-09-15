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
export function createFixtureAdapters(testCase, { writerMode } = {}) {
  return (counters) => {
    const fixtures = testCase.fixtures || {};
    const searchByQuery = fixtures.search || {};
    const readBySource = fixtures.read || {};
    const resolvedWriterMode = writerMode || fixtures.writer || 'faithful';

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
          // 生产 Worker 会把 query-local Web Provider id 命名空间化；fixture 的
          // read map 仍以原始 provider id 为稳定键，避免把该生产身份规则泄漏进 case JSON。
          const fixtureSourceId = String(source.id || '').replace(/-query-\d+$/u, '');
          const read = readBySource[source.id] || readBySource[fixtureSourceId];
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
        const lines = (resolvedWriterMode === 'invalid_citations')
          ? evidence.map((item) => `- ${item.claim} [99]`)
          : evidence.map((item) => `- ${item.claim} [${item.citationNumber}]`);
        const references = evidence.map((item) =>
          `- [${item.citationNumber}] ${item.title || item.sourceId || item.citationId}`
        );
        return {
          draftReport: [
            '## 研究范围与方法',
            '本报告仅使用本轮 Evidence Pack 中的入选证据，并按结构化引用编号标注。',
            '',
            '## 研究结论',
            ...lines,
            '',
            '## 局限',
            '以上结论仅基于本次检索到的证据，超出证据范围的问题未给出结论。',
            '',
            '## 参考资料',
            ...references
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

function projectWriterEvidence(evidence) {
  return evidence.map((item) => ({
    citationId: item.citationId,
    citationNumber: item.citationNumber,
    claim: item.claim,
    passage: item.passage,
    passageContentHash: item.passageContentHash ?? null,
    subquestionId: item.subquestionId,
    readerKind: item.readerKind,
    sourceId: item.sourceId
  }));
}

/**
 * 让指定 Evidence Pack（旧路径或 Ledger would-be）经真实 Worker 的交付管线，
 * 从 outlining/writing/verifying 阶段恢复运行。
 *
 * 注入方式（Codex 修正第 2 点）：利用 extracting 完成后的持久化 checkpoint，
 * 构造白名单 upstream artifacts（只保留计划与注入 Pack 自身的一致统计），
 * 将 citations/evidence 替换为指定 Pack 并重算 evidencePack 统计，
 * 从 outlining 阶段恢复真实 Worker。不展开下游产物（sections/draftReport/
 * verifiedReport/verification/quality/writing diagnostics）。
 * Phase B 显式设置 evidenceLedgerMode: 'off'（只验证 Pack 后交付，不触发
 * shadow finalize）。
 *
 * Writer 调用边界断言：真实 API 只接收 evidence，因此对完整 evidence 投影做
 * deepEqual；citation membership、编号与顺序则从注入 checkpoint 和最终 artifact
 * 独立验证，不声称 Writer API 接收了 citations。
 *
 * 返回契约（Codex 修正第 1 点）：
 * - deliveryLegal：来自最终 CompletionPolicy verdict；
 * - writerStatus：callCount/attempted 来自实际调用捕获，采纳模式与原因来自最终
 *   artifacts.diagnostics.writing；
 * - citationValidity：来自最终 verification.valid。
 * 消费端必须先断言这些字段不是 undefined 再进行比较。
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

  // —— 构造 extracting 完成后的白名单 checkpoint ——
  // 只保留上游字段，删除全部下游产物（Codex 修正第 2 点）。
  const packCitations = pack.citations;
  const packEvidence = pack.evidence;
  const citationById = new Map(packCitations.map((citation) => [citation.id, citation]));
  const sourceKey = (citation) => String(
    citation?.canonicalSourceId || citation?.url || citation?.sourceId || citation?.id || ''
  );
  const acceptedSourceKeys = new Set(packCitations.map(sourceKey).filter(Boolean));
  const readSourceKeys = new Set(packEvidence
    .filter((item) => item.readerKind !== 'search_snippet')
    .map((item) => sourceKey(citationById.get(item.citationId)) || String(item.sourceId || ''))
    .filter(Boolean));
  assert.ok(readSourceKeys.size <= acceptedSourceKeys.size,
    '正文读取独立来源数不得超过 accepted 独立来源数');
  for (const key of readSourceKeys) {
    assert.ok(acceptedSourceKeys.has(key), `正文读取来源 ${key} 必须属于 accepted 独立来源`);
  }
  const checkpointArtifacts = {
    subquestions: baseArtifacts.subquestions,
    plan: baseArtifacts.plan,
    evidencePack: {
      candidateCount: acceptedSourceKeys.size,
      acceptedCount: acceptedSourceKeys.size,
      excludedCount: 0,
      includedCount: packEvidence.length,
      citationCount: packCitations.length,
      readSourceCount: readSourceKeys.size,
      passageCount: packEvidence.length,
      totalCharacters: packEvidence.reduce((sum, item) => sum + (item.passage || '').length, 0),
      snippetFallbackCount: packEvidence.filter((item) => item.readerKind === 'search_snippet').length,
      policy: baseArtifacts.evidencePack?.policy,
      policyLabel: baseArtifacts.evidencePack?.policyLabel
    },
    citations: packCitations,
    evidence: packEvidence
  };

  // —— Phase B：从 outlining 恢复真实 Worker ——
  const phaseBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-phase-b-'));
  const store = createResearchStore(path.join(phaseBDir, 'b.sqlite'));
  try {
    let writerInput = null;
    let writerCallCount = 0;
    const adapters = createFixtureAdapters(testCase, { writerMode })({ writerCalls: 0 });
    const expectedCitationOrder = packCitations.map((citation) => ({
      id: citation.id,
      index: citation.index
    }));
    const expectedWriterInput = projectWriterEvidence(packEvidence);
    for (const item of packEvidence) {
      const citation = citationById.get(item.citationId);
      assert.ok(citation, `Evidence ${item.id} 引用了 checkpoint 中不存在的 citation ${item.citationId}`);
      assert.equal(item.citationNumber, citation.index,
        `Evidence ${item.id} 的 citationNumber 与 checkpoint citation.index 不一致`);
    }

    const worker = createResearchWorker({
      store,
      concurrency: 1,
      evidenceLedgerMode: 'off',
      planResearch: adapters.planResearch,
      searchSources: adapters.searchSources,
      readResearchSources: adapters.readResearchSources,
      writeResearchReport: async (writerArgs) => {
        writerCallCount += 1;
        // 这里只捕获实际输入；断言必须在 Worker 的 fallback catch 外执行。
        const evidence = writerArgs.evidence || [];
        writerInput = projectWriterEvidence(evidence);
        return adapters.writeResearchReport({ evidence });
      },
      resolveResearchRepositories: async () => []
    });

    const created = store.create({
      question: testCase.question,
      searchMode: testCase.searchMode,
      knowledgeBaseIds: testCase.knowledgeBaseIds || []
    });
    store.update(created.id, {
      stage: 'outlining',
      progress: 60,
      artifacts: checkpointArtifacts,
      citations: packCitations
    });

    const finalTask = await worker.enqueue(created.id);
    assert.equal(writerCallCount, packEvidence.length ? 1 : 0,
      'Writer 必须按真实交付路径调用一次或因零证据跳过');
    assert.deepEqual(writerInput, packEvidence.length ? expectedWriterInput : null,
      'Writer 实际输入 evidence 与指定 Pack 不一致');
    assert.deepEqual(
      (finalTask.artifacts?.citations || []).map((citation) => ({ id: citation.id, index: citation.index })),
      expectedCitationOrder,
      'checkpoint citations 的 membership、编号和顺序必须原样保留'
    );
    const writing = finalTask.artifacts?.diagnostics?.writing || {};
    const verdict = evaluateCompletionContract({
      task: finalTask,
      artifacts: finalTask.artifacts || {},
      mode: 'shadow',
      budget: { replans: { used: 0, limit: 1 }, repairs: { used: 0, limit: 1 } }
    });

    // 实际调用观测与最终 writing diagnostics 共同形成 Writer 状态。
    const writerStatus = {
      callCount: writerCallCount,
      attempted: writerCallCount > 0,
      accepted: writerCallCount > 0 && writing.mode === 'model',
      mode: writing.mode || 'fallback',
      reasonCode: writing.reasonCode || '',
      fallbackReason: writing.fallbackReason || ''
    };
    return {
      task: finalTask,
      quality: finalTask.artifacts?.quality || {},
      verdict,
      writerStatus,
      deliveryLegal: verdict.passed === true,
      citationValidity: finalTask.artifacts?.verification?.valid === true,
      writerInputObserved: writerInput
    };
  } finally {
    store.close();
    fs.rmSync(phaseBDir, { recursive: true, force: true });
  }
}
