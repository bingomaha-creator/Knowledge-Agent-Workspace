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
 * 多缺陷 nextAction 优先级（Spec §9.2 分流顺序）：先处理不安全的确定性交付/
 * Writer 缺陷（repair_report），报告安全后再处理证据缺口（replan /
 * deliver_insufficient）；基础设施异常由执行链按有界 retry 处理，重试后仍不可
 * 判定才 fail。证据缺口不得掩盖 Writer rejection。
 *
 * 质量检查永不缺席：可评估时给出明确结果，不可评估时必须以 passed=null +
 * observed.status='not_evaluated' 显式输出，不允许从 checks 中消失（Spec §8.1/§13.4）。
 */

export const COMPLETION_POLICY_VERSION = 2;
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
const MAX_SNIPPET_FALLBACK_RATE = 0.5;

/**
 * 必需章节按"角色 + 别名"匹配（Spec §8.1 required_section）。不用单一精确中文
 * 复合标题：确定性 fallback 报告、fixture 写手与常见模型报告形态都应命中。
 * 别名基于 Phase 0 回放与 Phase 1 集成测试中的真实报告样本校准。
 */
const REQUIRED_SECTION_ROLES = Object.freeze([
  {
    role: 'methodology',
    label: '研究范围与方法',
    aliases: ['研究范围', '研究方法', '检索方式', '检索与取证', '方法', 'scope', 'methodology', 'method']
  },
  {
    role: 'conclusion_limitations',
    label: '结论与局限',
    aliases: ['综合结论', '结论', '限制', '局限', '下一步', 'conclusion', 'limitation', 'next step']
  },
  {
    role: 'references',
    label: '参考资料',
    aliases: ['参考资料', '参考来源', '引用来源', '参考文献', '引用', 'references', 'sources', 'citations']
  }
]);

function check({
  id,
  kind,
  required,
  passed,
  observed,
  explanation,
  cause = 'report_defect',
  threshold = null,
  artifactRefs = []
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
    artifactRefs,
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

function missingSectionRoles(report) {
  const headings = markdownHeadings(report).map((heading) => heading.toLowerCase());
  return REQUIRED_SECTION_ROLES
    .filter((role) => !role.aliases.some((alias) =>
      headings.some((heading) => heading.includes(alias.toLowerCase()))
    ))
    .map((role) => role.role);
}

function citationInputs(artifacts) {
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
  // 引用归属由本模块自行验证：所有 referencedCitationIds 都必须属于当前 Run 的
  // citations，不信任上游 verification.valid（Spec §8.1）。
  const citationIds = new Set(citations.map((item) => item.id));
  const foreignReferences = referencedIds.filter((id) => !citationIds.has(id));
  return {
    citations,
    verification,
    referencedIds,
    invalidNumbers,
    invalidMarkers,
    foreignReferences
  };
}

/**
 * 组装检查集。质量检查（required=false）全部恒在：可评估给出 true/false，
 * 不可评估给出 null + not_evaluated；确定性交付检查中仅 limitation_disclosure
 * 依赖前置（无局限标注时按空条件通过）。
 */
export function buildCompletionChecks({ task, artifacts }) {
  const safeArtifacts = artifacts || {};
  const { citations, verification, referencedIds, invalidNumbers, invalidMarkers, foreignReferences }
    = citationInputs(safeArtifacts);
  const evidence = Array.isArray(safeArtifacts.evidence) ? safeArtifacts.evidence : [];
  const writer = safeArtifacts.diagnostics?.writing || safeArtifacts.writer || null;
  const qualityMetrics = safeArtifacts.quality?.metrics || {};
  const quality = safeArtifacts.quality || {};
  const pack = safeArtifacts.evidencePack || {};
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
    passed: foreignReferences.length === 0 && invalidNumbers.length === 0,
    observed: {
      referencedCount: referencedIds.length,
      citationCount: citations.length,
      invalidCitationNumbers: invalidNumbers,
      foreignReferences
    },
    artifactRefs: ['artifacts.citations', 'artifacts.verification'],
    explanation: foreignReferences.length || invalidNumbers.length
      ? `报告引用中存在无法归属到本轮证据的项：越界编号 ${invalidNumbers.join('、') || '无'}；外来引用 ID ${foreignReferences.join('、') || '无'}。`
      : '报告做出的引用全部能归属到本轮结构化 citation（本模块自行验证，不信任上游标记）。',
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
    artifactRefs: ['artifacts.verification', 'artifacts.draftReport'],
    explanation: invalidMarkers.length
      ? `报告包含非法符号引用 marker：${invalidMarkers.join('、')}。`
      : '报告中没有非法引用 marker。',
    cause: 'report_defect'
  }));

  checks.push(check({
    id: 'delivery-mode-consistent',
    kind: 'delivery_mode_consistent',
    required: true,
    passed: deliveryMode === 'grounded_report' ? true : null,
    observed: {
      deliveryMode,
      citationCount: citations.length,
      evidenceCount: evidence.length
    },
    artifactRefs: ['artifacts.citations', 'artifacts.evidence'],
    explanation: deliveryMode === 'grounded_report'
      ? '报告以本轮证据为边界交付（grounded_report）。'
      : '本轮无证据，报告按 evidence_gap_report 交付；其"不产生事实性结论"的边界需要语义校验，当前阶段无法确定性评估。',
    cause: 'evidence_gap'
  }));

  const missingRoles = missingSectionRoles(report);
  checks.push(check({
    id: 'required-sections',
    kind: 'required_section',
    required: true,
    passed: missingRoles.length === 0,
    observed: {
      missingRoles,
      matchedBy: 'role-alias',
      headingCount: markdownHeadings(report).length
    },
    artifactRefs: ['task.report', 'artifacts.verifiedReport'],
    explanation: missingRoles.length
      ? `报告缺少必需章节角色：${missingRoles.join('、')}（按角色别名匹配，不依赖单一标题）。`
      : '报告覆盖全部必需章节角色。',
    cause: 'report_defect'
  }));

  const limitations = Array.isArray(quality.limitations) ? quality.limitations : [];
  checks.push(check({
    id: 'limitation-disclosure',
    kind: 'limitation_disclosure',
    required: true,
    passed: limitations.length ? reportDisclosesLimitation(report) : true,
    observed: {
      limitationCodes: limitations.map((item) => item.code),
      disclosureRequired: limitations.length > 0,
      disclosureFound: reportDisclosesLimitation(report)
    },
    artifactRefs: ['task.report', 'artifacts.quality.limitations'],
    explanation: limitations.length
      ? (reportDisclosesLimitation(report)
        ? '报告对已识别的局限做了显式披露。'
        : '本轮存在局限标注，但报告正文未发现局限披露表述。')
      : '本轮无局限标注，无需披露（空条件通过）。',
    cause: 'report_defect'
  }));

  checks.push(check({
    id: 'writer-input-boundary',
    kind: 'writer_input_boundary',
    required: true,
    passed: null,
    observed: {
      evidencePackCount: evidence.length
    },
    artifactRefs: ['artifacts.evidence'],
    explanation: 'Writer 实际输入是否仅包含本轮 Evidence Pack 需要 Evidence Ledger 观测（Phase 2），当前阶段无法评估。',
    cause: 'infra'
  }));

  // —— 研究质量检查（required=false，全部恒在，可评估或显式 not_evaluated）——

  checks.push(check({
    id: 'min-evidence',
    kind: 'min_evidence',
    required: false,
    passed: citations.length >= MIN_EVIDENCE_THRESHOLD,
    observed: { citationCount: citations.length },
    threshold: MIN_EVIDENCE_THRESHOLD,
    artifactRefs: ['artifacts.citations'],
    explanation: `本轮入选 citation ${citations.length} 条（阈值 ${MIN_EVIDENCE_THRESHOLD}）。`,
    cause: 'evidence_gap'
  }));

  const coverageRatio = Number.isFinite(Number(qualityMetrics.coverageRatio))
    ? Number(qualityMetrics.coverageRatio)
    : null;
  checks.push(check({
    id: 'subquestion-coverage',
    kind: 'subquestion_coverage',
    required: false,
    passed: coverageRatio === null ? null : coverageRatio >= MIN_COVERAGE_RATIO,
    observed: {
      coverageRatio,
      coveredCount: qualityMetrics.coveredSubquestionCount ?? null
    },
    threshold: MIN_COVERAGE_RATIO,
    artifactRefs: ['artifacts.quality.metrics'],
    explanation: coverageRatio === null
      ? '质量评估未产出覆盖率，无法评估。'
      : `子问题覆盖率 ${coverageRatio}（阈值 ${MIN_COVERAGE_RATIO}）。`,
    cause: 'evidence_gap'
  }));

  const distinctSources = distinctSourceCount(citations);
  checks.push(check({
    id: 'source-diversity',
    kind: 'source_diversity',
    required: false,
    passed: citations.length === 0 ? null : distinctSources >= MIN_DISTINCT_SOURCES,
    observed: {
      distinctSources,
      citationCount: citations.length,
      disclosureFound: reportDisclosesLimitation(report)
    },
    threshold: MIN_DISTINCT_SOURCES,
    artifactRefs: ['artifacts.citations'],
    explanation: citations.length === 0
      ? '没有入选 citation，多样性不适用。'
      : (distinctSources >= MIN_DISTINCT_SOURCES
        ? `证据来自 ${distinctSources} 个不同来源。`
        : `证据只来自 ${distinctSources} 个来源；来源不足不得伪造多样性，需要披露局限或补充来源。`),
    cause: 'evidence_gap'
  }));

  const acceptedCount = Number(pack.acceptedCount ?? 0);
  const readSourceCount = Number(pack.readSourceCount ?? 0);
  checks.push(check({
    id: 'fulltext-read-rate',
    kind: 'fulltext_read_rate',
    required: false,
    passed: acceptedCount === 0 ? null : readRate(acceptedCount, readSourceCount) >= MIN_FULLTEXT_READ_RATE,
    observed: {
      readSourceCount,
      acceptedCount,
      readRate: acceptedCount === 0 ? null : Number((readSourceCount / acceptedCount).toFixed(4))
    },
    threshold: MIN_FULLTEXT_READ_RATE,
    artifactRefs: ['artifacts.evidencePack'],
    explanation: acceptedCount === 0
      ? '没有通过筛选的来源，正文读取率不适用。'
      : `通过筛选的来源中 ${readSourceCount}/${acceptedCount} 读到了正文。`,
    cause: 'evidence_gap'
  }));

  const passageCount = Number(pack.passageCount ?? 0);
  const snippetFallbackCount = Number(pack.snippetFallbackCount ?? 0);
  const snippetFallbackRate = passageCount === 0 ? null : Number((snippetFallbackCount / passageCount).toFixed(4));
  checks.push(check({
    id: 'snippet-fallback-rate',
    kind: 'snippet_fallback_rate',
    required: false,
    passed: passageCount === 0 ? null : snippetFallbackRate <= MAX_SNIPPET_FALLBACK_RATE,
    observed: {
      snippetFallbackCount,
      passageCount,
      snippetFallbackRate
    },
    threshold: MAX_SNIPPET_FALLBACK_RATE,
    artifactRefs: ['artifacts.evidencePack'],
    explanation: passageCount === 0
      ? '没有证据片段，snippet 回退率不适用。'
      : `${snippetFallbackCount}/${passageCount} 段证据使用搜索摘要而非正文。`,
    cause: 'evidence_gap'
  }));

  const webCitations = citations.filter((item) => item.kind === 'web');
  // provenance 与局限披露是两个独立语义（Codex 三次评审第 3 点）：本检查只反映
  // 来源是否经过一手验证——verified_primary 之外（含 candidate_primary/unknown）
  // 都不算已验证；报告是否披露局限由 limitation_disclosure 判定，披露只能记录在
  // observed 里，不能让 provenance 自动通过。
  const unverifiedWeb = webCitations.filter(
    (item) => item.provenance !== 'verified_primary'
  );
  checks.push(check({
    id: 'source-provenance',
    kind: 'source_provenance',
    required: false,
    passed: webCitations.length === 0 ? null : unverifiedWeb.length === 0,
    observed: {
      webCitationCount: webCitations.length,
      unverifiedCount: unverifiedWeb.length,
      disclosureFound: reportDisclosesLimitation(report)
    },
    artifactRefs: ['artifacts.citations'],
    explanation: webCitations.length === 0
      ? '没有外部来源，provenance 校验不适用。'
      : (unverifiedWeb.length === 0
        ? '全部外部来源都已确认为 verified_primary 一手来源。'
        : `${unverifiedWeb.length} 条外部来源尚未通过一手验证（candidate_primary/unknown 均不计为已验证）；报告是否披露该局限由 limitation-disclosure 判定。`),
    cause: 'evidence_gap'
  }));

  checks.push(check({
    id: 'writer-output-accepted',
    kind: 'writer_output_accepted',
    required: false,
    passed: evidence.length === 0 || !writer
      ? null
      : writer.mode === 'model',
    observed: {
      writerAttempted: evidence.length > 0 && Boolean(writer),
      writerMode: writer?.mode || null,
      writerStatus: writer?.status || null,
      reasonCode: writer?.reasonCode || '',
      fallbackReason: writer?.fallbackReason || ''
    },
    artifactRefs: ['artifacts.diagnostics.writing'],
    explanation: evidence.length === 0 || !writer
      ? 'Writer 未尝试写作（无证据或缺少写作诊断），无法评估。'
      : (writer.mode === 'model'
        ? '模型报告通过引用校验并被采纳。'
        : `模型报告未通过校验（${writer.reasonCode || '未知原因'}），已降级为确定性证据摘要。`),
    cause: 'report_defect'
  }));

  checks.push(check({
    id: 'claim-support',
    kind: 'claim_support',
    required: false,
    passed: null,
    observed: {
      citationCount: citations.length,
      evidenceCount: evidence.length
    },
    artifactRefs: ['artifacts.citations', 'artifacts.evidence'],
    explanation: 'claim-evidence 语义支持率需要人工标注或独立 Judge 口径（Spec §8.1/§13.4），不将"有合法 citation ID"当作语义支持；Phase 1 不评估。',
    cause: 'infra'
  }));

  checks.push(check({
    id: 'conflict-detection',
    kind: 'conflict_detection',
    required: false,
    passed: null,
    observed: {
      evidenceCount: evidence.length
    },
    artifactRefs: ['artifacts.evidence'],
    explanation: '来源之间的显式冲突与未解决问题检测依赖 Evidence Ledger 与语义比对（Phase 2+），当前阶段无法评估。',
    cause: 'infra'
  }));

  return { checks, deliveryMode, limitations };
}

function readRate(acceptedCount, readSourceCount) {
  return readSourceCount / acceptedCount;
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
    // 多缺陷优先级（Spec §9.2）：先修复不安全的交付/Writer 缺陷，再考虑补证据，
    // 不让证据缺口掩盖 Writer rejection。
    passed = requiredFailures.length === 0;
    if (requiredFailures.length || writerRejected) {
      nextAction = 'repair_report';
      nextActionReason = writerRejected && !requiredFailures.length
        ? '模型报告被拒并降级为确定性摘要，建议修复报告后重评。'
        : `交付检查未通过（${requiredFailures.map((item) => item.id).join('、')}），建议修复报告。`;
    } else if (gapFailures.length) {
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
