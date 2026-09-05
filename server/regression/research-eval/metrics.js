/**
 * Phase 0 评测的共享指标计算。
 *
 * 输入一次 Run 的最终 task 快照与执行计数，输出可比较、可持久化的基线指标。
 * 只依赖公开 artifacts 形状（store/worker 持久化结果），不读取模块内部状态，
 * 与 docs/specs/research-harness.md §13.4 的 interface 测试约束一致。
 *
 * Phase 0 的 claim-evidence 语义支持率没有自动化判定（人工/Judge 口径），
 * 恒为 null 并标注 not_evaluated；启用判定属于 Phase 3 之后的独立评测工作。
 */

function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function ratio(numerator, denominator) {
  const denom = Number(denominator);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return round4(Number(numerator) / denom);
}

function citationTraceableRatio(artifacts) {
  const citations = Array.isArray(artifacts.citations) ? artifacts.citations.length : 0;
  const verification = artifacts.verification || {};
  const referenced = Array.isArray(verification.referencedCitationIds)
    ? verification.referencedCitationIds.length
    : 0;
  return ratio(referenced, citations);
}

export function computeCaseMetrics({ testCase, task, latencyMs, counters, mode }) {
  const artifacts = task?.artifacts || {};
  const pack = artifacts.evidencePack || {};
  const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
  const quality = artifacts.quality || {};
  const qualityMetrics = quality.metrics || {};
  const diagnostics = artifacts.diagnostics || {};
  const readingFailures = Array.isArray(artifacts.reading?.failures)
    ? artifacts.reading.failures.length
    : 0;
  const inputTokens = Number(diagnostics.planning?.inputTokens || 0)
    + Number(diagnostics.writing?.inputTokens || 0);
  const outputTokens = Number(diagnostics.planning?.outputTokens || 0)
    + Number(diagnostics.writing?.outputTokens || 0);

  return {
    caseId: testCase.id,
    mode,
    searchMode: task?.searchMode || testCase.searchMode,
    status: task?.status || 'unknown',
    failedStage: task?.failedStage || '',
    resultQuality: task?.resultQuality || quality.quality || null,
    webSearchStatus: task?.webSearchStatus || '',
    subquestionCount: qualityMetrics.totalSubquestionCount
      ?? (Array.isArray(artifacts.subquestions) ? artifacts.subquestions.length : 0),
    coverageRatio: qualityMetrics.coverageRatio ?? null,
    evidence: {
      candidateCount: pack.candidateCount ?? null,
      acceptedCount: pack.acceptedCount ?? null,
      includedCount: pack.includedCount ?? citations.length,
      citationCount: pack.citationCount ?? citations.length,
      passageCount: pack.passageCount ?? null,
      readSourceCount: pack.readSourceCount ?? null,
      totalCharacters: pack.totalCharacters ?? null,
      snippetFallbackCount: pack.snippetFallbackCount ?? null
    },
    fullTextReadRate: ratio(pack.readSourceCount, pack.acceptedCount),
    snippetFallbackRate: ratio(pack.snippetFallbackCount, pack.passageCount),
    citationTraceableRatio: citationTraceableRatio(artifacts),
    claimSupportRate: null,
    claimSupportStatus: 'not_evaluated',
    writerMode: diagnostics.writing?.mode || 'fallback',
    writerStatus: diagnostics.writing?.status || null,
    limitationCodes: (quality.limitations || []).map((item) => item.code),
    readerFailures: readingFailures,
    latencyMs,
    externalCalls: { ...counters },
    tokens: { inputTokens, outputTokens }
  };
}

/**
 * 两次回放对比时剔除延迟字段：确定性指“指标结论可复现”，不包含墙钟时间。
 */
export function stripTiming(metrics) {
  const { latencyMs, ...rest } = metrics;
  return rest;
}
