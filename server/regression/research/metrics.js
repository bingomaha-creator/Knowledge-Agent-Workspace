/**
 * Phase 0 评测的共享指标计算。
 *
 * 输入一次 Run 的最终 task 快照与执行计数，输出可比较、可持久化的基线指标。
 * 只依赖公开 artifacts 形状（store/worker 持久化结果），不读取模块内部状态，
 * 与 docs/specs/research-harness.md §13.4 的 interface 测试约束一致。
 *
 * 引用指标采用两个独立口径（不得合并为单一"可追溯率"）：
 * - citationValidityRate（引用有效性）：报告做出的引用中，能映射到结构化
 *   citation 的比例；被引用的每条 citation 都必须可追溯到证据，这是 Phase 2
 *   Ledger"100% 可追溯"验收的口径。
 * - evidenceUsageRate（证据使用率）：Evidence Pack 装配出的 citation 中，被
 *   报告实际引用的比例。低于 1 是正常现象（候选允许不被使用），不作为缺陷。
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

function citationMetrics(artifacts) {
  const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
  const verification = artifacts.verification || {};
  const referencedIds = Array.isArray(verification.referencedCitationIds)
    ? verification.referencedCitationIds
    : [];
  const invalidNumbers = Array.isArray(verification.invalidCitationNumbers)
    ? verification.invalidCitationNumbers
    : [];
  const invalidMarkers = Array.isArray(verification.invalidCitationMarkers)
    ? verification.invalidCitationMarkers
    : [];
  // 有效性必须覆盖全部非法引用类型：越界数字引用与符号 marker（如 [q2]）都不得计入有效，
  // 任何一类非法 marker 的存在都使 100% 可追溯门槛不可达。
  const invalidReferenceCount = invalidNumbers.length + invalidMarkers.length;
  const totalReferences = referencedIds.length + invalidReferenceCount;
  return {
    citationStructureValid: verification.valid === true,
    citationValidityRate: totalReferences > 0
      ? round4(referencedIds.length / totalReferences)
      : null,
    // 零候选 citation 且零引用时"使用率"不适用：以 null 表达（摘要平均会排除 null），不得用 0 冒充。
    evidenceUsageRate: citations.length > 0 ? ratio(referencedIds.length, citations.length) : null,
    invalidReferenceCount,
    invalidCitationCount: invalidNumbers.length,
    invalidMarkerCount: invalidMarkers.length,
    referencedCitationCount: referencedIds.length,
    citationCount: citations.length
  };
}

export function computeCaseMetrics({ testCase, task, latencyMs, counters, mode }) {
  const artifacts = task?.artifacts || {};
  const pack = artifacts.evidencePack || {};
  const quality = artifacts.quality || {};
  const qualityMetrics = quality.metrics || {};
  const diagnostics = artifacts.diagnostics || {};
  const writer = diagnostics.writing || {};
  const readingFailures = Array.isArray(artifacts.reading?.failures)
    ? artifacts.reading.failures.length
    : 0;
  const inputTokens = Number(diagnostics.planning?.inputTokens || 0)
    + Number(writer.inputTokens || 0);
  const outputTokens = Number(diagnostics.planning?.outputTokens || 0)
    + Number(writer.outputTokens || 0);

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
      includedCount: pack.includedCount ?? null,
      citationCount: pack.citationCount ?? null,
      passageCount: pack.passageCount ?? null,
      readSourceCount: pack.readSourceCount ?? null,
      totalCharacters: pack.totalCharacters ?? null,
      snippetFallbackCount: pack.snippetFallbackCount ?? null
    },
    fullTextReadRate: ratio(pack.readSourceCount, pack.acceptedCount),
    snippetFallbackRate: ratio(pack.snippetFallbackCount, pack.passageCount),
    ...citationMetrics(artifacts),
    claimSupportRate: null,
    claimSupportStatus: 'not_evaluated',
    limitationCodes: (quality.limitations || []).map((item) => item.code),
    writerMode: writer.mode || 'fallback',
    writerStatus: writer.status || null,
    writerReasonCode: writer.reasonCode || '',
    writerFallbackReason: writer.fallbackReason || '',
    writerModelAttempted: Number(counters?.writerCalls || 0) > 0,
    readerFailures: readingFailures,
    webSearch: {
      // 计入"发出了 web 请求但未正常可用"的查询数（unavailable/error）；
      // 部分降级即说明该 case 的外部证据可能不完整，与 valid=true 不冲突。
      degradedQueries: Number(counters?.webSearchDegradedQueries || 0)
    },
    latencyMs,
    externalCalls: { ...counters },
    tokens: { inputTokens, outputTokens }
  };
}

/**
 * 两次回放对比时剔除延迟字段：确定性指"指标结论可复现"，不包含墙钟时间。
 */
export function stripTiming(metrics) {
  const { latencyMs, ...rest } = metrics;
  return rest;
}
