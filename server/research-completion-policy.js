/**
 * CompletionPolicy —— Spec docs/specs/research-harness.md §5.3/§8 的唯一实现。
 *
 * 纯函数：输入 Run 与最终 artifacts 的公开形状，输出结构化 verdict 与建议动作。
 * 不发起检索、不写库、不读取任何模块内部状态；本文件同时是调用方与测试的唯一表面。
 *
 * Phase 1 = shadow（Spec §8.3/§12）：verdict 与 nextAction 真实计算，但执行链必须
 * 忽略它们，仅持久化与展示；本阶段不启用 completion gate / retry / replan / repair。
 * gate 聚合口径在同一纯函数内实现并测试（Spec §8.2 两种聚合分别有测试约定），
 * Phase 3 启用前不得有任何调用方以 mode='gate' 驱动执行。
 *
 * passed 语义（Spec §8.2）：boolean | null。null 只表示本次无法评估
 * （observed.status='not_evaluated'），不表示通过。
 * - Shadow 聚合：required check 的 null 不计入 failure，仅观测。
 * - Gate 聚合：required check 不得以 null 通过完成门禁——按 notEvaluableCause
 *   分流（Spec §8.2）：report_defect → repair_report；evidence_gap → replan
 *   （预算耗尽时按能否安全交付取 deliver_insufficient / fail）；infra → fail
 *   （执行链应先行有界 adapter retry，重试后仍不可判定才落到 fail，Spec §9.2）。
 *   任何 required null 都不会输出 complete。
 *
 * 质量检查（required=false）的失败只用于产生建议与 resultQuality 对照，不阻止完成。
 */

export const COMPLETION_POLICY_VERSION = 1;
export const COMPLETION_MODES = Object.freeze(['shadow', 'gate']);
export const COMPLETION_NEXT_ACTIONS = Object.freeze([
  'complete',
  'replan',
  'repair_report',
  'deliver_insufficient',
  'fail'
]);

const DEFAULT_BUDGET = Object.freeze({
  replans: { used: 0, limit: 1 },
  repairs: { used: 0, limit: 1 }
});

const MIN_EVIDENCE_THRESHOLD = 3;
const MIN_COVERAGE_RATIO = 0.75;
const MIN_FULLTEXT_READ_RATE = 0.5;
const MIN_DISTINCT_SOURCES = 2;

function check({
  id,
  kind,
  required,
  passed,
  observed,
  explanation,
  cause = 'report_defect',
  threshold = null
}) {
  return {
    id,
    kind,
    required: required === true,
    threshold,
    verifier: 'completion-policy',
    verifierVersion: COMPLETION_POLICY_VERSION,
    passed: passed === true ? true : passed === false ? false : null,
    observed: {
      status: passed === null ? 'not_evaluated' : 'evaluated',
      ...observed
    },
    explanation,
    // cause 描述该检查失败/不可评估时的分流类别（Spec §8.2）：report_defect →
    // repair_report；evidence_gap → replan / deliver_insufficient；infra → retry 后 fail。
    cause,
    notEvaluableCause: passed === null ? cause : null
  };
}

function markdownHeadings(report) {
  return String(report || '')
    .split('\n')
    .map((line) => line.match(/^#{1,4}\s+(.+?)\s*$/u)?.[1] || '')
    .filter(Boolean);
}

function reportDisclosesLimitation(report) {
  return /局限|限制|limitation/iu.test(String(report || ''));
}

function distinctSourceCount(citations) {
  const keys = new Set();
  for (const citation of citations) {
    keys.add(citation.url ? `url:${citation.url}` : `id:${citation.id}`);
  }
  return keys.size;
}

function citationInputs(artifacts) {
  const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
  const verification = artifacts.verification || {};
  return {
    citations,
    verification,
    referencedIds: Array.isArray(verification.referencedCitationIds)
      ? verification.referencedCitationIds
      : [],
    invalidNumbers: Array.isArray(verification.invalidCitationNumbers)
      ? verification.invalidCitationNumbers
      : [],
    invalidMarkers: Array.isArray(verification.invalidCitationMarkers)
      ? verification.invalidCitationMarkers
      : []
  };
}

/**
 * 组装检查集。有前置条件的检查只在前置成立时纳入（如无局限标注时不产生
 * limitation_disclosure），避免用 null 冒充"已评估"。
 */
export function buildCompletionChecks({ task, artifacts }) {
  const safeArtifacts = artifacts || {};
  const { citations, verification, invalidNumbers, invalidMarkers } = citationInputs(safeArtifacts);
  const evidence = Array.isArray(safeArtifacts.evidence) ? safeArtifacts.evidence : [];
  const writer = safeArtifacts.diagnostics?.writing || safeArtifacts.writer || null;
  const qualityMetrics = safeArtifacts.quality?.metrics || {};
  const quality = safeArtifacts.quality || {};
  const report = typeof task?.report === 'string' && task.report
    ? task.report
    : (typeof safeArtifacts.verifiedReport === 'string' ? safeArtifacts.verifiedReport : '');
  const deliveryMode = citations.length ? 'grounded_report' : 'evidence_gap_report';
  const checks = [];

  // —— 确定性交付检查（required=true，Spec §8.1）——

  checks.push(check({
    id: 'citation-membership',
    kind: 'citation_membership',
    required: true,
    passed: invalidNumbers.length === 0,
    observed: {
      referencedCount: verification.referencedCitationIds?.length ?? 0,
      citationCount: citations.length,
      invalidCitationNumbers: invalidNumbers
    },
    explanation: invalidNumbers.length
      ? `报告引用了 ${invalidNumbers.length} 个不属于本轮证据的编号：${invalidNumbers.join('、')}。`
      : '报告做出的引用全部能映射到本轮结构化 citation。',
    cause: 'report_defect'
  }));

  checks.push(check({
    id: 'no-invalid-markers',
    kind: 'no_invalid_markers',
    required: true,
    passed: invalidMarkers.length === 0 && invalidNumbers.length === 0,
    observed: {
      invalidCitationMarkers: invalidMarkers,
      invalidCitationNumbers: invalidNumbers
    },
    explanation: invalidMarkers.length
      ? `报告包含非法符号引用 marker：${invalidMarkers.join('、')}。`
      : '报告中没有非法引用 marker。',
    cause: 'report_defect'
  }));

  checks.push(check({
    id: 'delivery-mode-consistent',
    kind: 'delivery_mode_consistent',
    required: true,
    passed: deliveryMode === 'grounded_report'
      ? true
      : null,
    observed: {
      deliveryMode,
      citationCount: citations.length,
      evidenceCount: evidence.length
    },
    explanation: deliveryMode === 'grounded_report'
      ? '报告以本轮证据为边界交付（grounded_report）。'
      : '本轮无证据，报告按 evidence_gap_report 交付；其"不产生事实性结论"的边界需要语义校验，当前阶段无法确定性评估。',
    cause: 'evidence_gap'
  }));

  const requiredHeadings = ['研究范围与方法', '综合结论、限制与下一步', '参考资料'];
  const headings = markdownHeadings(report);
  const missingSections = requiredHeadings.filter(
    (name) => !headings.some((heading) => heading.toLowerCase().includes(name.toLowerCase()))
  );
  checks.push(check({
    id: 'required-sections',
    kind: 'required_section',
    required: true,
    passed: missingSections.length === 0,
    observed: {
      missingSections,
      headingCount: headings.length
    },
    explanation: missingSections.length
      ? `报告缺少必需章节：${missingSections.join('、')}。`
      : '报告包含全部必需章节。',
    cause: 'report_defect'
  }));

  const limitations = Array.isArray(quality.limitations) ? quality.limitations : [];
  if (limitations.length) {
    checks.push(check({
      id: 'limitation-disclosure',
      kind: 'limitation_disclosure',
      required: true,
      passed: reportDisclosesLimitation(report),
      observed: {
        limitationCodes: limitations.map((item) => item.code),
        disclosureFound: reportDisclosesLimitation(report)
      },
      explanation: reportDisclosesLimitation(report)
        ? '报告对已识别的局限做了显式披露。'
        : '本轮存在局限标注，但报告正文未发现局限披露表述。',
      cause: 'report_defect'
    }));
  }

  checks.push(check({
    id: 'writer-input-boundary',
    kind: 'writer_input_boundary',
    required: true,
    passed: null,
    observed: {
      evidencePackCount: evidence.length
    },
    explanation: 'Writer 实际输入是否仅包含本轮 Evidence Pack 需要 Evidence Ledger 观测（Phase 2），当前阶段无法评估。',
    cause: 'infra'
  }));

  // —— 研究质量检查（required=false，shadow 决定建议与 resultQuality 对照）——

  checks.push(check({
    id: 'min-evidence',
    kind: 'min_evidence',
    required: false,
    passed: citations.length >= MIN_EVIDENCE_THRESHOLD,
    observed: { citationCount: citations.length },
    threshold: MIN_EVIDENCE_THRESHOLD,
    explanation: `本轮入选 citation ${citations.length} 条（阈值 ${MIN_EVIDENCE_THRESHOLD}）。`,
    cause: 'evidence_gap'
  }));

  const coverageRatio = Number.isFinite(Number(qualityMetrics.coverageRatio))
    ? Number(qualityMetrics.coverageRatio)
    : null;
  if (coverageRatio !== null) {
    checks.push(check({
      id: 'subquestion-coverage',
      kind: 'subquestion_coverage',
      required: false,
      passed: coverageRatio >= MIN_COVERAGE_RATIO,
      observed: { coverageRatio, coveredCount: qualityMetrics.coveredSubquestionCount ?? null },
      threshold: MIN_COVERAGE_RATIO,
      explanation: `子问题覆盖率 ${coverageRatio}（阈值 ${MIN_COVERAGE_RATIO}）。`,
      cause: 'evidence_gap'
    }));
  }

  if (citations.length > 0) {
    const distinctSources = distinctSourceCount(citations);
    checks.push(check({
      id: 'source-diversity',
      kind: 'source_diversity',
      required: false,
      passed: distinctSources >= MIN_DISTINCT_SOURCES,
      observed: {
        distinctSources,
        citationCount: citations.length,
        disclosureFound: reportDisclosesLimitation(report)
      },
      threshold: MIN_DISTINCT_SOURCES,
      explanation: distinctSources >= MIN_DISTINCT_SOURCES
        ? `证据来自 ${distinctSources} 个不同来源。`
        : `证据只来自 ${distinctSources} 个来源；来源不足不得伪造多样性，需要披露局限或补充来源。`,
      cause: 'evidence_gap'
    }));
  }

  const acceptedCount = Number(safeArtifacts.evidencePack?.acceptedCount ?? 0);
  const readSourceCount = Number(safeArtifacts.evidencePack?.readSourceCount ?? 0);
  if (acceptedCount > 0) {
    const readRate = readSourceCount / acceptedCount;
    checks.push(check({
      id: 'fulltext-read-rate',
      kind: 'fulltext_read_rate',
      required: false,
      passed: readRate >= MIN_FULLTEXT_READ_RATE,
      observed: {
        readSourceCount,
        acceptedCount,
        readRate: Number(readRate.toFixed(4)),
        snippetFallbackCount: safeArtifacts.evidencePack?.snippetFallbackCount ?? null
      },
      threshold: MIN_FULLTEXT_READ_RATE,
      explanation: `通过筛选的来源中 ${readSourceCount}/${acceptedCount} 读到了正文。`,
      cause: 'evidence_gap'
    }));
  }

  const writerAttempted = evidence.length > 0 && Boolean(writer);
  if (writerAttempted) {
    checks.push(check({
      id: 'writer-output-accepted',
      kind: 'writer_output_accepted',
      required: false,
      passed: writer.mode === 'model',
      observed: {
        writerMode: writer.mode || null,
        writerStatus: writer.status || null,
        reasonCode: writer.reasonCode || '',
        fallbackReason: writer.fallbackReason || ''
      },
      explanation: writer.mode === 'model'
        ? '模型报告通过引用校验并被采纳。'
        : `模型报告未通过校验（${writer.reasonCode || '未知原因'}），已降级为确定性证据摘要。`,
      cause: 'report_defect'
    }));
  }

  if (citations.length > 0) {
    checks.push(check({
      id: 'claim-support',
      kind: 'claim_support',
      required: false,
      passed: null,
      observed: {
        citationCount: citations.length
      },
      explanation: 'claim-evidence 语义支持率需要人工标注或独立 Judge 口径（Spec §8.1/§13.4），不将"有合法 citation ID"当作语义支持；Phase 1 不评估。',
      cause: 'infra'
    }));
  }

  return { checks, deliveryMode, limitations };
}

function replanBudgetAvailable(budget) {
  return Number(budget.replans.used) < Number(budget.replans.limit);
}

function deliverySafe(checks) {
  const disclosure = checks.find((item) => item.id === 'limitation-disclosure');
  return disclosure ? disclosure.passed === true : false;
}

/**
 * Gate 聚合下的 required-null 分流（Spec §8.2）。
 * infra 类返回 fail：执行链在进入 verdict 前应已完成有界 adapter retry（Spec §9.2），
 * 重试后仍不可判定的检查在此收敛为诚实失败。
 */
function dispatchRequiredNull(nullCheck, budget, checks) {
  if (nullCheck.notEvaluableCause === 'evidence_gap') {
    if (replanBudgetAvailable(budget)) {
      return { nextAction: 'replan', reason: `必需检查 ${nullCheck.id} 因证据缺口无法评估，且 replan 预算可用。` };
    }
    if (deliverySafe(checks)) {
      return { nextAction: 'deliver_insufficient', reason: `必需检查 ${nullCheck.id} 因证据缺口无法评估且 replan 预算已耗尽；报告可安全交付为证据缺口说明。` };
    }
    return { nextAction: 'fail', reason: `必需检查 ${nullCheck.id} 无法评估、replan 预算耗尽且报告缺少安全披露。` };
  }
  if (nullCheck.notEvaluableCause === 'report_defect') {
    return { nextAction: 'repair_report', reason: `必需检查 ${nullCheck.id} 因报告缺陷无法评估，应修复报告后重评。` };
  }
  return { nextAction: 'fail', reason: `必需检查 ${nullCheck.id} 因验证基础设施不可用而无法评估；执行链应先行有界 adapter retry，重试后仍不可判定则诚实失败。` };
}

/**
 * 聚合 checks → verdict 主体。独立导出：gate 的 complete 分支需要合成 checks 才能
 * 在 Phase 2 之前被测试覆盖——writer_input_boundary 在真实 artifacts 上恒为 null，
 * gate 口径按设计 fail-closed，任何真实 run 都不可能 complete。
 */
export function aggregateCompletionVerdict({ checks, mode, budget }) {
  const requiredFailures = checks.filter((item) => item.required && item.passed === false);
  const requiredNulls = checks.filter((item) => item.required && item.passed === null);
  const qualityFailures = checks.filter((item) => !item.required && item.passed === false);
  const gapFailures = qualityFailures.filter((item) => item.cause === 'evidence_gap');
  const writerRejected = qualityFailures.some((item) => item.id === 'writer-output-accepted');

  let passed;
  let nextAction;
  let nextActionReason;

  if (mode === 'gate') {
    passed = requiredFailures.length === 0 && requiredNulls.length === 0;
    if (requiredNulls.length) {
      const dispatch = dispatchRequiredNull(requiredNulls[0], budget, checks);
      nextAction = dispatch.nextAction;
      nextActionReason = dispatch.reason;
    } else if (requiredFailures.length) {
      nextAction = 'repair_report';
      nextActionReason = `确定性交付检查未通过：${requiredFailures.map((item) => item.id).join('、')}。`;
    } else {
      nextAction = 'complete';
      nextActionReason = '全部必需检查有明确通过结果，交付安全。';
    }
  } else {
    // Shadow 聚合：required null 不计入失败，仅观测（Spec §8.2）。
    passed = requiredFailures.length === 0;
    if (gapFailures.length) {
      if (replanBudgetAvailable(budget)) {
        nextAction = 'replan';
        nextActionReason = `证据覆盖不足（${gapFailures.map((item) => item.id).join('、')}），replan 预算可用，建议一次针对性补检索。`;
      } else if (deliverySafe(checks)) {
        nextAction = 'deliver_insufficient';
        nextActionReason = '证据覆盖不足且 replan 预算已耗尽；建议按证据缺口诚实交付。';
      } else {
        nextAction = 'fail';
        nextActionReason = '证据覆盖不足、replan 预算耗尽且报告缺少安全披露。';
      }
    } else if (requiredFailures.length || writerRejected) {
      nextAction = 'repair_report';
      nextActionReason = requiredFailures.length
        ? `交付检查未通过（${requiredFailures.map((item) => item.id).join('、')}），建议修复报告。`
        : '模型报告被拒并降级为确定性摘要，建议修复报告后重评。';
    } else {
      nextAction = 'complete';
      nextActionReason = '交付检查通过，证据覆盖满足阈值。';
    }
  }

  return {
    passed,
    nextAction,
    nextActionReason,
    deliveryFailures: requiredFailures.map((item) => item.id),
    qualityFailures: qualityFailures.map((item) => item.id),
    notEvaluableRequired: requiredNulls.map((item) => item.id)
  };
}

/**
 * 计算完成契约 verdict。
 *
 * @param {object} input
 * @param {object} input.task 最终 task 快照（report/resultQuality 等）
 * @param {object} input.artifacts 最终 artifacts
 * @param {'shadow'|'gate'} [input.mode] 聚合口径；Phase 1 只允许 shadow 驱动展示
 * @param {{ replans?: {used?: number, limit?: number}, repairs?: {used?: number, limit?: number} }} [input.budget]
 *   RunBudget 中与建议动作相关的计数；Phase 1 动作从不执行，仅用于建议分流。
 */
export function evaluateCompletionContract({ task, artifacts, mode = 'shadow', budget } = {}) {
  if (!COMPLETION_MODES.includes(mode)) {
    throw new TypeError(`evaluateCompletionContract: 未知的聚合口径 ${mode}`);
  }
  const safeBudget = {
    replans: {
      used: Number(budget?.replans?.used ?? DEFAULT_BUDGET.replans.used),
      limit: Number(budget?.replans?.limit ?? DEFAULT_BUDGET.replans.limit)
    },
    repairs: {
      used: Number(budget?.repairs?.used ?? DEFAULT_BUDGET.repairs.used),
      limit: Number(budget?.repairs?.limit ?? DEFAULT_BUDGET.repairs.limit)
    }
  };
  const { checks, deliveryMode } = buildCompletionChecks({ task, artifacts });
  const aggregated = aggregateCompletionVerdict({ checks, mode, budget: safeBudget });
  return {
    mode,
    verifier: 'completion-policy',
    verifierVersion: COMPLETION_POLICY_VERSION,
    deliveryMode,
    checks,
    ...aggregated
  };
}
