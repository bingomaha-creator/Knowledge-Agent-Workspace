/**
 * Phase 0 评测执行器：把固定 case 跑进真实的 createResearchWorker 状态机，
 * 只注入 planner / search / reader / writer 四个 adapter（Spec 保持不动的注入 seam）。
 *
 * fixture 模式的四个 adapter 全部是确定性内存实现，不发起任何网络或模型调用；
 * live 模式由 research-eval-live.js 注入真实 Qwen / 博查 / Reader 适配器。
 * Store 使用一次性临时 SQLite 文件，与开发数据库完全隔离。
 */
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
 * 让指定 Evidence Pack（旧路径或 Ledger would-be）经真实 Worker 的完整交付管线
 * （写作 → 验证 → 质量评估 → 完成契约），返回交付结果摘要。
 *
 * 注入方式（Codex 修正第 2 点）：通过适配器把 Pack 注入检索/读取阶段——
 * - 全文层来源提供 content（Reader 成功路径）；
 * - 薄层来源仅提供 snippet（Reader 失败 → snippet 回退自然发生）；
 * - Writer 行为忠实传入（writerMode：faithful | invalid_citations），
 *   invalid-citations 用例真实验证拒绝与确定性 fallback 重建。
 * 不复制 Worker 语义：readSourceCount 由真实读取诊断按独立来源去重计数。
 * 语义支持率等无法离线评估的指标显式 not_evaluated（Policy 已输出 null）。
 *
 * @param {object} input
 * @param {object} input.pack { citations, evidence }——待评估的 Evidence Pack
 * @param {object} input.testCase Phase 0 case（提供 plan/searchQuery 映射）
 * @param {string} [input.writerMode] faithful | invalid_citations
 */
export async function runPackThroughDelivery({ pack, testCase, writerMode = 'faithful' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-delivery-'));
  const store = createResearchStore(path.join(dir, 'pack.sqlite'));
  try {
    const plan = testCase.fixtures.plan.subquestions;
    const planByQuestion = new Map(plan.map((item) => [item.question, item]));

    // Pack citations 按子问题分组：would-be citation 带 subquestionId；
    // 旧 citation 经 queries[0]（子问题 question）反查。
    const sourcesByQuery = {};
    for (const citation of Array.isArray(pack.citations) ? pack.citations : []) {
      const sub = citation.subquestionId
        ? plan.find((item) => item.id === citation.subquestionId)
        : planByQuestion.get((citation.queries || [])[0]);
      if (!sub) continue;
      const passages = (Array.isArray(pack.evidence) ? pack.evidence : [])
        .filter((item) => item.citationId === citation.id);
      if (!passages.length) continue;
      const sourceId = `src-${citation.id}`;
      const fulltext = passages.some((item) => item.readerKind !== 'search_snippet');
      (sourcesByQuery[sub.searchQuery] ||= []).push({
        id: sourceId,
        title: citation.title || '',
        url: citation.url || `https://pack.local/${encodeURIComponent(sourceId)}`,
        snippet: passages[0].passage.slice(0, 1_000),
        content: fulltext ? passages.map((item) => item.passage).join('\n\n') : undefined
      });
    }

    const adapters = {
      planResearch: async () => ({
        planner: 'fixture',
        subquestions: plan,
        diagnostics: { mode: 'fixture', status: 'success', durationMs: 0, inputTokens: 0, outputTokens: 0 }
      }),
      searchSources: async ({ query, searchMode }) => {
        const entry = sourcesByQuery[query] || {};
        const web = searchMode === 'local' ? [] : (entry.web || entry.local || []);
        const local = searchMode === 'web' ? [] : (entry.local || entry.web || []);
        const webSearchStatus = searchMode === 'local'
          ? 'not_requested'
          : (web.length ? 'available' : 'unavailable');
        return { local, web, webSearchStatus };
      },
      readResearchSources: async ({ sources }) => {
        const documents = [];
        const failures = [];
        for (const source of sources) {
          if (source.content) {
            documents.push({ sourceId: source.id, content: source.content, readerKind: 'pack_fulltext' });
          } else {
            failures.push({
              sourceId: source.id,
              code: 'unsupported_source',
              message: 'pack 薄层来源无正文',
              retryable: false
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
        const refs = writerMode === 'invalid_citations'
          ? evidence.map((item) => `- ${item.claim} [99]`)
          : evidence.map((item) => `- ${item.claim} [${item.citationNumber}]`);
        return {
          draftReport: [
            '## 研究范围与方法',
            '评测基线。',
            ...refs,
            '## 综合结论、限制与下一步',
            '以上结论仅基于本轮证据。'
          ].join('\n'),
          diagnostics: { mode: 'fixture', status: 'success', reasonCode: '', inputTokens: 0, outputTokens: 0 }
        };
      }
    };

    const worker = createResearchWorker({ store, concurrency: 1, ...adapters });
    const created = store.create({
      question: testCase.question,
      searchMode: testCase.searchMode,
      knowledgeBaseIds: testCase.knowledgeBaseIds || []
    });
    const task = await worker.enqueue(created.id);
    const quality = task.artifacts?.quality || {};
    const verdict = evaluateCompletionContract({
      task,
      artifacts: task.artifacts || {},
      mode: 'shadow',
      budget: { replans: { used: 0, limit: 1 }, repairs: { used: 0, limit: 1 } }
    });
    return {
      task,
      verification: task.artifacts?.verification || null,
      writerMode: task.artifacts?.diagnostics?.writing?.mode || 'fallback',
      quality,
      verdict,
      deliveryLegal: verdict.passed === true,
      citationValidity: task.artifacts?.verification?.valid === true
    };
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
