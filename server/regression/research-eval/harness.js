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
 */
export async function runEvalCase({ testCase, adapters, mode, dbPath }) {
  if (typeof adapters !== 'function') throw new TypeError('adapters 必须是 (counters) => workerDeps 工厂');
  const store = createResearchStore(dbPath);
  try {
    const counters = {
      plannerCalls: 0,
      writerCalls: 0,
      searchCalls: 0,
      webSearchRequests: 0,
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
    return computeCaseMetrics({ testCase, task, latencyMs, counters, mode });
  } finally {
    store.close();
  }
}
