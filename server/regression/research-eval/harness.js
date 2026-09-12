/**
 * Phase 0 评测执行器：把固定 case 跑进真实的 createResearchWorker 状态机，
 * 只注入 planner / search / reader / writer 四个 adapter（Spec 保持不动的注入 seam）。
 *
 * fixture 模式的四个 adapter 全部是确定性内存实现，不发起任何网络或模型调用；
 * live 模式由 research-eval-live.js 注入真实 Qwen / 博查 / Reader 适配器。
 * Store 使用一次性临时 SQLite 文件，与开发数据库完全隔离。
 */
import { createResearchStore } from '../../research-store.js';
import { createResearchWorker } from '../../research-worker.js';
import { verifyReport } from '../../research-report.js';
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
 * 让指定 Evidence Pack（旧路径或 Ledger would-be）经历同一确定性 Writer、
 * verifyReport 与 Completion Contract（shadow 口径），返回交付结果摘要。
 * 用于第二交付门的"报告质量不劣化"对比：交付合法性、required checks、
 * 引用有效性、子问题覆盖、局限披露、Writer 采纳状态。语义支持率等无法
 * 离线评估的指标显式 not_evaluated（Spec research-harness §8.1/§13.4）。
 *
 * @param {object} input
 * @param {object} input.pack { citations, evidence }——待评估的 Evidence Pack
 * @param {string} input.question 研究问题
 * @param {string} [input.searchMode] 检索模式
 * @param {Array} [input.subquestions] 子问题（含 question），供覆盖率评估
 * @param {string} [input.writerMode] faithful | invalid_citations
 */
export function runPackThroughDelivery({ pack, question, searchMode = 'web', subquestions = [], writerMode = 'faithful' }) {
  const citations = Array.isArray(pack.citations) ? pack.citations : [];
  const evidence = Array.isArray(pack.evidence) ? pack.evidence : [];
  const lines = writerMode === 'invalid_citations'
    ? evidence.map((item) => `- ${item.claim} [99]`)
    : evidence.map((item) => `- ${item.claim} [${item.citationNumber}]`);
  const draftReport = [
    '## 研究范围与方法',
    '评测基线。',
    ...lines,
    '## 综合结论、限制与下一步',
    '以上结论仅基于本轮证据。'
  ].join('\n');
  // 上面的 join 使用真实换行：这里手工构造与 worker 写作阶段一致的报告结构。
  const verified = verifyReport(draftReport, citations);
  const adopted = verified.verification.valid && verified.verification.referencedCitationIds.length > 0;
  const writer = adopted
    ? { mode: 'model', status: 'success', reasonCode: '', fallbackReason: '' }
    : { mode: 'fallback', status: 'degraded', reasonCode: 'invalid_citations', fallbackReason: '引用未通过校验' };

  const snippetFallbackCount = evidence.filter((item) => item.readerKind === 'search_snippet').length;
  const quality = assessResearchQuality(
    { question, searchMode, knowledgeBaseIds: [] },
    {
      citations,
      evidence,
      verification: verified.verification,
      evidencePack: {
        acceptedCount: citations.length,
        readSourceCount: evidence.filter((item) => item.readerKind !== 'search_snippet').length,
        passageCount: evidence.length,
        totalCharacters: evidence.reduce((sum, item) => sum + item.passage.length, 0),
        snippetFallbackCount
      },
      writer,
      subquestions: subquestions.map((item) => item.question)
    }
  );
  const verdict = evaluateCompletionContract({
    task: { report: verified.report, resultQuality: quality.quality, searchMode },
    artifacts: {
      citations,
      evidence,
      verification: verified.verification,
      diagnostics: { writing: writer },
      plan: { subquestions: subquestions.map((item) => ({ id: item.id, question: item.question })) },
      quality
    },
    mode: 'shadow'
  });

  return {
    report: verified.report,
    verification: verified.verification,
    writer,
    quality,
    verdict,
    deliveryLegal: verdict.passed === true,
    citationValidity: verified.verification.valid === true
  };
}
