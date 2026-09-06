/**
 * CompletionPolicy 测试（Spec §8.2：shadow/gate 两种聚合分别有测试约定）。
 *
 * 覆盖 Phase 0 暴露的两个 shadow 信号：
 * 1. 非法模型引用触发 writer fallback → 建议 repair_report（不执行）；
 * 2. 证据覆盖不足 → 按原因与预算建议 replan 或 deliver_insufficient（不执行）。
 * 以及：多缺陷优先级（Writer 缺陷不被证据缺口掩盖）、artifactRefs 全覆盖、
 * citation membership 自验、章节角色别名匹配、质量检查恒在（可评估或显式 null）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateCompletionVerdict,
  evaluateCompletionContract
} from './research-completion-policy.js';

const FULL_REPORT = [
  '# 异步深度研究报告',
  '## 研究范围与方法',
  '本次研究按请求执行检索。',
  '## 综合结论、限制与下一步',
  '结论以引用为边界。',
  '## 参考资料',
  '[1] 来源一',
  '[2] 来源二',
  '[3] 来源三'
].join('\n');

const GAP_REPORT = [
  '# 异步深度研究报告',
  '## 研究范围与方法',
  '本次检索没有命中资料。',
  '## 综合结论、限制与下一步',
  '本次检索没有命中可引用资料，因此不作事实性推断。',
  '## 参考资料',
  '本次研究没有可列出的参考资料。'
].join('\n');

function citation(id, index) {
  return { id, index, title: `来源 ${index}`, url: `https://example.org/${index}`, kind: 'web', provenance: 'verified_primary' };
}

function healthyArtifacts(overrides = {}) {
  return {
    citations: [citation('c1', 1), citation('c2', 2), citation('c3', 3)],
    evidence: [
      { citationId: 'c1', claim: '证据一' },
      { citationId: 'c2', claim: '证据二' },
      { citationId: 'c3', claim: '证据三' }
    ],
    verification: {
      valid: true,
      referencedCitationIds: ['c1', 'c2', 'c3'],
      invalidCitationNumbers: [],
      invalidCitationMarkers: []
    },
    evidencePack: { acceptedCount: 3, readSourceCount: 3, passageCount: 3, snippetFallbackCount: 0 },
    diagnostics: {
      writing: { mode: 'model', status: 'success', reasonCode: '', fallbackReason: '' }
    },
    quality: {
      metrics: { coverageRatio: 1, coveredSubquestionCount: 2, totalSubquestionCount: 2 },
      limitations: []
    },
    verifiedReport: FULL_REPORT,
    ...overrides
  };
}

function shadowNextAction(artifacts, budget) {
  return evaluateCompletionContract({
    task: { report: artifacts.verifiedReport, resultQuality: 'limited' },
    artifacts,
    mode: 'shadow',
    budget
  });
}

function checksById(verdict) {
  return Object.fromEntries(verdict.checks.map((item) => [item.id, item]));
}

test('shadow 健康运行：交付检查通过，建议 complete；artifactRefs 全覆盖', () => {
  const verdict = shadowNextAction(healthyArtifacts());
  assert.equal(verdict.mode, 'shadow');
  assert.equal(verdict.passed, true);
  assert.equal(verdict.nextAction, 'complete');
  assert.equal(verdict.deliveryMode, 'grounded_report');
  assert.ok(verdict.checks.length >= 12, `质量检查恒在：实际 ${verdict.checks.length} 项`);
  for (const item of verdict.checks) {
    assert.ok(Array.isArray(item.artifactRefs) && item.artifactRefs.length > 0,
      `${item.id} 必须携带 artifactRefs（Spec §8.2）`);
  }
  const byId = checksById(verdict);
  assert.equal(byId['writer-output-accepted'].passed, true);
  assert.equal(byId['claim-support'].passed, null, 'claim_support 在 Phase 1 恒为 not_evaluated');
  assert.equal(byId['conflict-detection'].passed, null, '冲突检测在 Phase 1 恒为 not_evaluated，但不得缺席');
  assert.equal(byId['snippet-fallback-rate'].passed, true);
  assert.equal(byId['source-provenance'].passed, true);
  assert.equal(byId['writer-input-boundary'].passed, null);
  assert.deepEqual(verdict.notEvaluableRequired, ['writer-input-boundary']);
});

test('citation membership 自验：不信任上游 verification，外来引用 ID 记为失败', () => {
  const verdict = shadowNextAction(healthyArtifacts({
    verification: {
      valid: true,
      referencedCitationIds: ['c1', 'c2', 'c-from-another-run'],
      invalidCitationNumbers: [],
      invalidCitationMarkers: []
    }
  }));
  const byId = checksById(verdict);
  assert.equal(byId['citation-membership'].passed, false,
    '上游 valid=true 也不能掩盖引用不属于当前 Run 的事实');
  assert.deepEqual(byId['citation-membership'].observed.foreignReferences, ['c-from-another-run']);
  assert.equal(verdict.nextAction, 'repair_report');
});

test('shadow 信号一：模型报告非法引用被拒并降级 → 建议 repair_report', () => {
  const verdict = shadowNextAction(healthyArtifacts({
    diagnostics: {
      writing: {
        mode: 'fallback',
        status: 'degraded',
        reasonCode: 'invalid_citations',
        fallbackReason: '模型报告缺少有效的证据引用，已使用确定性证据摘要'
      }
    }
  }));
  assert.equal(verdict.passed, true, '降级后的确定性最终报告本身交付安全（required 检查通过）');
  const byId = checksById(verdict);
  assert.equal(byId['writer-output-accepted'].passed, false);
  assert.equal(byId['writer-output-accepted'].observed.reasonCode, 'invalid_citations');
  assert.equal(verdict.nextAction, 'repair_report');
  assert.ok(verdict.nextActionReason.includes('模型报告被拒'));
});

test('shadow 信号二：证据覆盖不足 → 预算可用时建议 replan', () => {
  const verdict = shadowNextAction(healthyArtifacts({
    quality: {
      metrics: { coverageRatio: 0.3333, coveredSubquestionCount: 1, totalSubquestionCount: 3 },
      limitations: [{ code: 'low_subquestion_coverage', message: '只有 1/3 个子问题获得了相关证据。' }]
    }
  }));
  const byId = checksById(verdict);
  assert.equal(byId['subquestion-coverage'].passed, false);
  assert.equal(byId['limitation-disclosure'].passed, true, '报告包含局限披露表述');
  assert.equal(verdict.nextAction, 'replan');
  assert.ok(verdict.nextActionReason.includes('replan 预算可用'));
});

test('多缺陷优先级：Writer rejection + 证据缺口并存 → 先 repair_report，不被 replan 掩盖', () => {
  const verdict = shadowNextAction(healthyArtifacts({
    diagnostics: {
      writing: {
        mode: 'fallback',
        status: 'degraded',
        reasonCode: 'invalid_citations',
        fallbackReason: '模型报告缺少有效的证据引用，已使用确定性证据摘要'
      }
    },
    quality: {
      metrics: { coverageRatio: 0.3333, coveredSubquestionCount: 1, totalSubquestionCount: 3 },
      limitations: [{ code: 'low_subquestion_coverage', message: '只有 1/3 个子问题获得了相关证据。' }]
    }
  }));
  assert.equal(verdict.nextAction, 'repair_report',
    'Writer 缺陷优先于证据缺口（Spec §9.2：报告安全后再补证据）');
  assert.deepEqual([...verdict.qualityFailures].sort(), ['subquestion-coverage', 'writer-output-accepted'],
    '两类缺陷同时在列，但建议动作必须是 repair_report');
});

test('shadow 信号二变体：零证据且 replan 预算耗尽 → 建议 deliver_insufficient', () => {
  const zeroEvidence = healthyArtifacts({
    citations: [],
    evidence: [],
    verification: { valid: true, referencedCitationIds: [], invalidCitationNumbers: [], invalidCitationMarkers: [] },
    evidencePack: { acceptedCount: 0, readSourceCount: 0, passageCount: 0, snippetFallbackCount: 0 },
    quality: {
      metrics: { coverageRatio: 0, coveredSubquestionCount: 0, totalSubquestionCount: 2 },
      limitations: [{ code: 'no_relevant_evidence', message: '没有找到足够相关的证据。' }]
    },
    verifiedReport: GAP_REPORT
  });
  const withBudget = shadowNextAction(zeroEvidence, { replans: { used: 1, limit: 1 } });
  assert.equal(withBudget.nextAction, 'deliver_insufficient');
  assert.ok(withBudget.nextActionReason.includes('replan 预算已耗尽'));

  const withFreshBudget = shadowNextAction(zeroEvidence);
  assert.equal(withFreshBudget.nextAction, 'replan', 'replan 预算可用时优先建议补检索');

  // Shadow 口径下 required null（delivery_mode_consistent）不计为失败：
  assert.ok(withFreshBudget.notEvaluableRequired.includes('delivery-mode-consistent'));
  const byId = checksById(withFreshBudget);
  assert.equal(byId['delivery-mode-consistent'].passed, null);
  assert.equal(byId['delivery-mode-consistent'].observed.status, 'not_evaluated');
  assert.equal(byId['delivery-mode-consistent'].observed.deliveryMode, 'evidence_gap_report');
  // 质量检查恒在：不可评估的以 null 显式输出，不得从 checks 中消失
  assert.equal(byId['writer-output-accepted'].passed, null, 'Writer 未尝试时显式 not_evaluated');
  assert.equal(byId['snippet-fallback-rate'].passed, null);
  assert.equal(byId['source-provenance'].passed, null);
  assert.equal(byId['source-diversity'].passed, null);
  assert.equal(byId['fulltext-read-rate'].passed, null);
});

test('provenance 与披露拆分：candidate_primary/未知来源不计为已验证，披露不使其自动通过', () => {
  // candidate_primary 不是 verified_primary：全部候选来源都视为未验证
  const candidates = healthyArtifacts({
    citations: [citation('c1', 1), citation('c2', 2), citation('c3', 3)].map((item) => ({
      ...item,
      provenance: 'candidate_primary'
    })),
    quality: {
      metrics: { coverageRatio: 1, coveredSubquestionCount: 2, totalSubquestionCount: 2 },
      limitations: [{ code: 'public_source_provenance_unverified', message: '外部来源尚未确认。' }]
    }
  });
  const candidateVerdict = shadowNextAction(candidates);
  const candidateById = checksById(candidateVerdict);
  assert.equal(candidateById['source-provenance'].passed, false,
    'candidate_primary 不得等同于 verified_primary');
  assert.equal(candidateById['source-provenance'].observed.disclosureFound, true,
    '披露情况记录在 observed，供 limitation-disclosure 与前端展示');
  assert.equal(candidateById['limitation-disclosure'].passed, true, '披露判断由 limitation-disclosure 承担');

  // 未知来源但已披露：provenance 仍未通过；预算耗尽时报告可被诚实交付
  const unknownDisclosed = healthyArtifacts({
    citations: [citation('c1', 1), citation('c2', 2), citation('c3', 3)].map((item) => ({
      ...item,
      provenance: 'unknown'
    })),
    quality: {
      metrics: { coverageRatio: 1, coveredSubquestionCount: 2, totalSubquestionCount: 2 },
      limitations: [{ code: 'public_source_provenance_unverified', message: '外部来源尚未确认。' }]
    }
  });
  const exhausted = shadowNextAction(unknownDisclosed, { replans: { used: 1, limit: 1 } });
  const exhaustedById = checksById(exhausted);
  assert.equal(exhaustedById['source-provenance'].passed, false, '未知来源仍未通过 provenance');
  assert.equal(exhaustedById['limitation-disclosure'].passed, true);
  assert.equal(exhausted.nextAction, 'deliver_insufficient', '报告诚实披露时可安全交付');
  assert.equal(exhausted.passed, true, '交付安全，shadow 下 passed 不受 optional 失败影响');
});

test('required_sections 按角色别名匹配，不依赖单一精确中文标题', () => {
  const modelStyle = healthyArtifacts({
    verifiedReport: [
      '# 报告',
      '## 检索方式',
      '受控联网检索。',
      '## 结论与限制',
      '结论以引用为边界。',
      '## References',
      '[1] 来源'
    ].join('\n')
  });
  const byId = checksById(shadowNextAction(modelStyle));
  assert.equal(byId['required-sections'].passed, true,
    '别名命中：检索方式→methodology，结论与限制→conclusion_limitations，References→references');

  const missing = healthyArtifacts({
    verifiedReport: '# 报告\n\n只有结论，没有范围与参考章节。\n\n## 结论\n内容。'
  });
  const missingVerdict = shadowNextAction(missing);
  const missingById = checksById(missingVerdict);
  assert.equal(missingById['required-sections'].passed, false);
  assert.ok(missingById['required-sections'].observed.missingRoles.includes('methodology'));
  assert.ok(missingById['required-sections'].observed.missingRoles.includes('references'));
});

test('gate 口径：真实 artifacts 因 writer_input_boundary 恒为 null 而 fail-closed', () => {
  const verdict = evaluateCompletionContract({
    task: { report: FULL_REPORT, resultQuality: 'sufficient' },
    artifacts: healthyArtifacts(),
    mode: 'gate'
  });
  assert.equal(verdict.passed, false, 'gate 下 required null 不得通过完成门禁');
  assert.equal(verdict.nextAction, 'fail');
  assert.ok(verdict.nextActionReason.includes('有界 adapter retry'), 'infra 原因必须提示先走有界 retry');
});

test('gate 口径表驱动：required null 按 notEvaluableCause 分流，optional null 不阻断', () => {
  const check = (overrides) => ({
    id: overrides.id,
    kind: overrides.kind || overrides.id,
    required: overrides.required === true,
    passed: 'passed' in overrides ? overrides.passed : null,
    observed: { status: overrides.passed === null ? 'not_evaluated' : 'evaluated' },
    explanation: '',
    artifactRefs: ['synthetic'],
    cause: overrides.cause || null,
    notEvaluableCause: overrides.passed === null ? (overrides.cause || null) : null
  });
  const budget = { replans: { used: 0, limit: 1 }, repairs: { used: 0, limit: 1 } };

  // 全部必需检查有明确通过结果 → complete；optional null（claim_support）不阻断
  const complete = aggregateCompletionVerdict({
    mode: 'gate',
    budget,
    checks: [
      check({ id: 'a', required: true, passed: true }),
      check({ id: 'b', required: false, passed: null, cause: 'infra' })
    ]
  });
  assert.equal(complete.passed, true);
  assert.equal(complete.nextAction, 'complete');

  // required false（报告缺陷）→ repair_report
  const repair = aggregateCompletionVerdict({
    mode: 'gate',
    budget,
    checks: [check({ id: 'citation-membership', required: true, passed: false, cause: 'report_defect' })]
  });
  assert.equal(repair.nextAction, 'repair_report');

  // required null + evidence_gap + replan 预算可用 → replan
  const replan = aggregateCompletionVerdict({
    mode: 'gate',
    budget,
    checks: [check({ id: 'delivery-mode-consistent', required: true, passed: null, cause: 'evidence_gap' })]
  });
  assert.equal(replan.nextAction, 'replan');

  // required null + evidence_gap + 预算耗尽 + 有安全披露 → deliver_insufficient
  const deliver = aggregateCompletionVerdict({
    mode: 'gate',
    budget: { replans: { used: 1, limit: 1 }, repairs: { used: 0, limit: 1 } },
    checks: [
      check({ id: 'delivery-mode-consistent', required: true, passed: null, cause: 'evidence_gap' }),
      check({ id: 'limitation-disclosure', required: true, passed: true, cause: 'report_defect' })
    ]
  });
  assert.equal(deliver.nextAction, 'deliver_insufficient');

  // required null + evidence_gap + 预算耗尽 + 无安全披露 → fail
  const failUnsafe = aggregateCompletionVerdict({
    mode: 'gate',
    budget: { replans: { used: 1, limit: 1 }, repairs: { used: 0, limit: 1 } },
    checks: [
      check({ id: 'delivery-mode-consistent', required: true, passed: null, cause: 'evidence_gap' }),
      check({ id: 'limitation-disclosure', required: true, passed: false, cause: 'report_defect' })
    ]
  });
  assert.equal(failUnsafe.nextAction, 'fail');

  // required null + infra → fail（retry 指引写入 reason）
  const infraFail = aggregateCompletionVerdict({
    mode: 'gate',
    budget,
    checks: [check({ id: 'writer-input-boundary', required: true, passed: null, cause: 'infra' })]
  });
  assert.equal(infraFail.nextAction, 'fail');
  assert.ok(infraFail.nextActionReason.includes('有界 adapter retry'));
});

test('passed 与 nextAction 只输出合法词汇，passed 严格为 boolean|null', () => {
  const verdict = shadowNextAction(healthyArtifacts());
  for (const item of verdict.checks) {
    assert.ok(item.passed === true || item.passed === false || item.passed === null,
      `${item.id} passed 必须是 boolean|null`);
    if (item.passed === null) {
      assert.equal(item.observed.status, 'not_evaluated');
      assert.ok(item.notEvaluableCause, 'null 检查必须携带 notEvaluableCause');
    }
  }
  assert.ok(['complete', 'replan', 'repair_report', 'deliver_insufficient', 'fail'].includes(verdict.nextAction));
});
