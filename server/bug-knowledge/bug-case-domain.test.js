import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBugCaseFingerprint,
  normalizeBugCaseContent,
  normalizeErrorSignatures,
  validateBugCaseConfirmation
} from './bug-case-domain.js';

function createValidCase(overrides = {}) {
  return normalizeBugCaseContent({
    title: 'Vue hydration mismatch',
    symptom: 'SSR 页面在客户端 hydration 时出现节点不一致。',
    errorSignatures: ['Hydration node mismatch at /Users/me/App.vue:42'],
    reproductionSteps: ['启动 SSR 服务', '刷新详情页'],
    context: {
      language: 'TypeScript',
      framework: 'Vue',
      versions: ['3.5.13'],
      module: 'product-detail',
      environment: 'Node 22 / Chrome'
    },
    resolutionType: 'root_cause_fix',
    rootCause: '服务端与客户端使用了不同的时区。',
    fix: '在两端使用同一个 UTC formatter。',
    verification: 'SSR 与 hydration 快照测试均通过。',
    tags: ['SSR', 'Vue'],
    sourceRefs: ['tests/product-detail.spec.ts'],
    ...overrides
  });
}

test('BugCase standardizes volatile error signatures before fingerprinting', () => {
  assert.deepEqual(
    normalizeErrorSignatures([
      ' TypeError: Failed at /Users/me/src/App.vue:42:7  ',
      'typeerror: failed at /Users/other/src/App.vue:99:12',
      'Request 8f14e45f-ea21-4d4f-a716-446655440000 failed'
    ]),
    [
      'typeerror: failed at <path>/app.vue:<n>:<n>',
      'request <uuid> failed'
    ]
  );

  const first = createValidCase();
  const second = createValidCase({
    errorSignatures: ['Hydration node mismatch at /tmp/build/App.vue:998']
  });
  assert.equal(buildBugCaseFingerprint(first), buildBugCaseFingerprint(second));
});

test('confirmation rules distinguish root-cause fixes from verified workarounds', () => {
  assert.throws(
    () => validateBugCaseConfirmation(createValidCase({ rootCause: '' })),
    (error) => error.code === 'BUG_CASE_ROOT_CAUSE_REQUIRED' && error.status === 422
  );

  const workaround = createValidCase({
    resolutionType: 'verified_workaround',
    rootCause: '',
    workaroundRisks: ['会禁用流式 SSR'],
    applicability: ['仅适用于 Vue 3.5.x'],
    verification: '在最小复现项目连续运行 20 次均通过。',
    sourceRefs: ['https://example.test/issue/123']
  });
  assert.doesNotThrow(() => validateBugCaseConfirmation(workaround));
  assert.equal(workaround.rootCause, null);

  for (const [field, value, expectedCode] of [
    ['workaroundRisks', [], 'BUG_CASE_WORKAROUND_RISKS_REQUIRED'],
    ['applicability', [], 'BUG_CASE_APPLICABILITY_REQUIRED'],
    ['verification', '', 'BUG_CASE_VERIFICATION_REQUIRED'],
    ['sourceRefs', [], 'BUG_CASE_SOURCE_REFS_REQUIRED']
  ]) {
    assert.throws(
      () => validateBugCaseConfirmation({ ...workaround, [field]: value }),
      (error) => error.code === expectedCode && error.status === 422
    );
  }
});

test('confirmation requires the shared evidence contract for every resolution type', () => {
  const createWorkaround = (overrides = {}) => createValidCase({
    resolutionType: 'verified_workaround',
    rootCause: '',
    workaroundRisks: ['会禁用流式 SSR'],
    applicability: ['仅适用于 Vue 3.5.x'],
    verification: '在最小复现项目连续运行 20 次均通过。',
    sourceRefs: ['https://example.test/issue/123'],
    ...overrides
  });

  const sharedEvidenceFailures = [
    ['context', { context: {} }, 'BUG_CASE_TECHNICAL_CONTEXT_REQUIRED'],
    [
      'error signature or reproduction steps',
      { errorSignatures: [], reproductionSteps: [] },
      'BUG_CASE_SIGNATURE_OR_REPRODUCTION_REQUIRED'
    ],
    ['verification', { verification: '' }, 'BUG_CASE_VERIFICATION_REQUIRED'],
    ['source refs', { sourceRefs: [] }, 'BUG_CASE_SOURCE_REFS_REQUIRED']
  ];

  for (const [field, overrides, expectedCode] of sharedEvidenceFailures) {
    for (const [resolutionType, createCase] of [
      ['root_cause_fix', createValidCase],
      ['verified_workaround', createWorkaround]
    ]) {
      assert.throws(
        () => validateBugCaseConfirmation(createCase(overrides)),
        (error) => error.code === expectedCode && error.status === 422,
        `${resolutionType} should reject missing ${field}`
      );
    }
  }
});

test('BugCase content rejects unknown metadata instead of silently persisting it', () => {
  assert.throws(
    () => normalizeBugCaseContent({
      ...createValidCase(),
      clientControlledReviewStatus: 'confirmed'
    }),
    (error) => error.code === 'BUG_CASE_UNKNOWN_FIELD' && error.status === 400
  );
});
