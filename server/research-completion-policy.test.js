/**
 * CompletionPolicy 测试（Spec §8.2：shadow/gate 两种聚合分别有测试约定）。
 *
 * 覆盖 Phase 0 暴露的两个 shadow 信号：
 * 1. 非法模型引用触发 writer fallback → 建议 repair_report（不执行）；
 * 2. 证据覆盖不足 → 按原因与预算建议 replan 或 deliver_insufficient（不执行）。
 * 以及 boolean|null 语义：required null 在 shadow 下不计失败、在 gate 下阻断 complete
 * 并按 notEvaluableCause 分流。
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
  return { id, index, title: `来源 ${index}`, url: `https://example.org/${index}`, kind: 'web' };
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
    evidencePack: { acceptedCount: 3, readSourceCount: 3, snippetFallbackCount: 0 },
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

test('shadow 健康运行：交付检查通过，建议 complete', () => {
  const verdict = shadowNextAction(healthyArtifacts());
  assert.equal(verdict.mode, 'shadow');
  assert.equal(verdict.passed, true);
  assert.equal(verdict.nextAction, 'complete');
  assert.equal(verdict.deliveryMode, 'grounded_report');
  const byId = Object.fromEntries(verdict.checks.map((item) => [item.id, item]));
  assert.equal(byId['writer-output-accepted'].passed, true);
  assert.equal(byId['claim-support'].passed, null, 'claim_support 在 Phase 1 恒为 not_evaluated');
  assert.equal(byId['writer-input-boundary'].passed, null);
  assert.deepEqual(verdict.notEvaluableRequired, ['writer-input-boundary']);
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
  const byId = Object.fromEntries(verdict.checks.map((item) => [item.id, item]));
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
  const byId = Object.fromEntries(verdict.checks.map((item) => [item.id, item]));
  assert.equal(byId['subquestion-coverage'].passed, false);
  assert.equal(byId['limitation-disclosure'].passed, true, '报告包含局限披露表述');
  assert.equal(verdict.nextAction, 'replan');
  assert.ok(verdict.nextActionReason.includes('replan 预算可用'));
});

test('shadow 信号二变体：零证据且 replan 预算耗尽 → 建议 deliver_insufficient', () => {
  const zeroEvidence = healthyArtifacts({
    citations: [],
    evidence: [],
    verification: { valid: true, referencedCitationIds: [], invalidCitationNumbers: [], invalidCitationMarkers: [] },
    evidencePack: { acceptedCount: 0, readSourceCount: 0, snippetFallbackCount: 0 },
    diagnostics: { writing: { mode: 'fallback', status: 'degraded', reasonCode: 'model_unavailable', fallbackReason: '未接入受证据约束的报告写作者' } },
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
  const byId = Object.fromEntries(withFreshBudget.checks.map((item) => [item.id, item]));
  assert.equal(byId['delivery-mode-consistent'].passed, null);
  assert.equal(byId['delivery-mode-consistent'].observed.status, 'not_evaluated');
  assert.equal(byId['delivery-mode-consistent'].observed.deliveryMode, 'evidence_gap_report');
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
    notEvaluableCause: overrides.cause || null
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
