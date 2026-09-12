/**
 * Phase 1 shadow side-table 写入守卫与事务语义测试。
 *
 * 覆盖（Codex 二次评审第 1/2/3 点）：
 * - 契约 checks 单事务整体替换（新旧 verdict 不混合，旧检查项被清除）；
 * - attempt 守卫：旧 attempt 迟到写入被拒绝；
 * - 状态守卫：cancelled 拒绝 budget 写入、completed 才能写 contract、failed 才能写 error；
 * - updatedAt 在同一事务内原子推进（前端轮询按 updatedAt 仲裁）；
 * - webSearchCalls 走 SQL 自增累计，upsertRunBudget 不覆盖它。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchStore } from './research-store.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-store-shadow-'));
  const store = createResearchStore(path.join(dir, 'guard.sqlite'));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function verdict(checkIds, { passed = true, nextAction = 'complete' } = {}) {
  const REQUIRED = new Set(['citation-membership', 'no-invalid-markers', 'delivery-mode-consistent', 'required-sections', 'limitation-disclosure', 'writer-input-boundary']);
  return {
    mode: 'shadow',
    passed,
    nextAction,
    nextActionReason: '测试',
    checks: checkIds.map((id) => ({
      id,
      kind: id,
      required: REQUIRED.has(id),
      passed: true,
      observed: { status: 'evaluated' },
      explanation: '',
      artifactRefs: ['synthetic'],
      verifier: 'completion-policy',
      verifierVersion: 2
    }))
  };
}

function claimedTask(store, question = '守卫测试') {
  const created = store.create({ question, searchMode: 'web', knowledgeBaseIds: [] });
  const claimed = store.claim(created.id);
  return { task: claimed, attempt: Number(claimed.attempt) };
}

test('契约 checks 单事务整体替换：新 verdict 生效，旧检查项被清除', () => {
  const { store, cleanup } = tempStore();
  try {
    const { task, attempt } = claimedTask(store);
    store.complete(task.id, { artifacts: {}, citations: [], report: '', resultQuality: 'limited', limitations: [] });

    assert.equal(store.recordContractChecks(task.id, verdict(['a', 'b']), { attempt }), true);
    let snapshot = store.getContractChecks(task.id);
    assert.deepEqual(snapshot.checks.map((item) => item.id).sort(), ['a', 'b']);

    // 重评后 verdict 只含 b/c：整体替换必须清掉 a，而不是与旧记录混合。
    assert.equal(store.recordContractChecks(task.id, verdict(['b', 'c']), { attempt }), true);
    snapshot = store.getContractChecks(task.id);
    assert.deepEqual(snapshot.checks.map((item) => item.id).sort(), ['b', 'c']);
  } finally {
    cleanup();
  }
});

test('attempt 守卫：旧 attempt 的迟到写入被拒绝且不改变数据', () => {
  const { store, cleanup } = tempStore();
  try {
    const { task } = claimedTask(store);
    const staleAttempt = Number(task.attempt) - 1;

    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 123 }, { attempt: staleAttempt }), false,
      '旧 attempt 的 budget 写入必须被拒绝');
    assert.equal(store.getRunBudget(task.id), null, '被拒绝的写入不得留下数据');

    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 123 }, { attempt: Number(task.attempt) }), true);
  } finally {
    cleanup();
  }
});

test('状态守卫：cancelled 拒绝 budget；contract 仅 completed；error 仅 failed', () => {
  const { store, cleanup } = tempStore();
  try {
    // cancelled：budget 写入被拒
    const cancelled = claimedTask(store, '取消守卫');
    store.cancel(cancelled.task.id);
    assert.equal(store.upsertRunBudget(cancelled.task.id, { wallTimeMs: 1 }, { attempt: cancelled.attempt }), false,
      '取消后迟到 budget 写入必须被拒绝（取消竞态）');

    // contract 仅 completed：running 状态写入被拒
    const running = claimedTask(store, 'contract 状态守卫');
    assert.equal(store.recordContractChecks(running.task.id, verdict(['a']), { attempt: running.attempt }), false,
      'running 状态不得写最终 contract');

    // completed 后可写 contract，但 error 仍被拒
    store.complete(running.task.id, { artifacts: {}, citations: [], report: '', resultQuality: 'limited', limitations: [] });
    assert.equal(store.recordContractChecks(running.task.id, verdict(['a']), { attempt: running.attempt }), true);
    assert.equal(store.recordRunError(running.task.id, { stage: 'writing', category: 'internal', message: 'x' }, { attempt: running.attempt }), false,
      'completed 状态不得写 error 分类');

    // error 仅 failed
    const failing = claimedTask(store, 'error 状态守卫');
    store.fail(failing.task.id, { failedStage: 'writing', error: 'x', artifacts: {} });
    assert.equal(store.recordRunError(failing.task.id, { stage: 'writing', category: 'upstream', message: 'y', retryable: true }, { attempt: failing.attempt }), true);
  } finally {
    cleanup();
  }
});

test('updatedAt 严格单调：同毫秒连续写入也必须至少 +1（前端仲裁依据）', () => {
  const { store, cleanup } = tempStore();
  try {
    const { task, attempt } = claimedTask(store);

    // 不做任何等待，制造同毫秒连续写入：withRunSnapshotWrite 必须保证
    // max(Date.now(), currentUpdatedAt + 1) 的严格单调语义。
    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 1 }, { attempt }), true);
    const first = store.get(task.id).updatedAt;
    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 2 }, { attempt }), true);
    const second = store.get(task.id).updatedAt;
    assert.ok(second > first, `同毫秒连续写入必须严格单调（${first} → ${second}）`);
    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 3 }, { attempt }), true);
    assert.ok(store.get(task.id).updatedAt > second);

    store.complete(task.id, { artifacts: {}, citations: [], report: '', resultQuality: 'limited', limitations: [] });
    const beforeContract = store.get(task.id).updatedAt;
    assert.equal(store.recordContractChecks(task.id, verdict(['a']), { attempt }), true);
    assert.ok(store.get(task.id).updatedAt > beforeContract, 'contract 写入必须原子推进 updatedAt');
  } finally {
    cleanup();
  }
});

test('组合提交：Ledger 写入失败时主快照一并回滚，不存在中间崩溃窗口', () => {
  const { store, cleanup } = tempStore();
  try {
    const { task, attempt } = claimedTask(store);
    assert.equal(task.stage, 'planning');

    // Ledger 侧写抛错（entries 不可迭代）→ 整个事务回滚：主快照不得前进到下一阶段，
    // 否则会出现"任务已进入 outlining、Ledger 尚未写入"的崩溃窗口。
    assert.throws(
      () => store.commitRunningStageWithLedger(
        task.id,
        { stage: 'extracting', progress: 45, artifacts: { v: 1 } },
        { attempt },
        { type: 'replace', entries: 123, artifacts: [], diff: { mode: 'shadow' } }
      ),
      Error
    );
    assert.equal(store.get(task.id).stage, 'planning', '主快照必须回滚到上一阶段');
    assert.equal(store.getEvidenceLedger(task.id), null, '台账同样回滚，无半写状态');

    // 正确 payload 重试 → 主快照与 Ledger 原子推进
    assert.equal(
      store.commitRunningStageWithLedger(
        task.id,
        { stage: 'extracting', progress: 45, artifacts: { v: 1 } },
        { attempt },
        {
          type: 'replace',
          entries: [{
            evidenceId: 'ev_a', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1',
            provenanceBefore: 'candidate_primary', provenanceAfter: 'candidate_primary',
            screeningStatus: 'accepted', readingStatus: 'succeeded',
            extractionStatus: 'extracted', citationStatus: 'writer_selected', citationId: 'web-s1'
          }],
          artifacts: [],
          diff: { mode: 'shadow', diagnostic: 'reading_eligibility' }
        }
      ),
      true
    );
    assert.equal(store.get(task.id).stage, 'extracting');
    const ledger = store.getEvidenceLedger(task.id);
    assert.equal(ledger.entries[0].citation.status, 'writer_selected', 'extracting 阶段只有 writer_selected');

    // verifying 收敛：citation 终态依据 referencedCitationIds
    const finalizeOk = store.commitRunningStageWithLedger(
      task.id,
      { stage: 'outlining', progress: 60, artifacts: { v: 2 } },
      { attempt },
      { type: 'citations', referencedCitationIds: ['web-s1'] }
    );
    assert.equal(finalizeOk, true);
    const finalized = store.getEvidenceLedger(task.id);
    assert.equal(finalized.entries[0].citation.status, 'cited', '被报告引用的来源收敛为 cited');

    // 未被报告引用的来源收敛为 not_cited
    store.commitRunningStageWithLedger(
      task.id,
      { stage: 'outlining', progress: 61, artifacts: { v: 3 } },
      { attempt },
      { type: 'citations', referencedCitationIds: [] }
    );
    assert.equal(store.getEvidenceLedger(task.id).entries[0].citation.status, 'not_cited');
  } finally {
    cleanup();
  }
});

test('webSearchCalls 累计：SQL 自增不被 upsertRunBudget 覆盖', () => {
  const { store, cleanup } = tempStore();
  try {
    const { task, attempt } = claimedTask(store);
    assert.equal(store.addRunBudgetWebSearchCalls(task.id, 1, { attempt }), true);
    assert.equal(store.addRunBudgetWebSearchCalls(task.id, 2, { attempt }), true);
    assert.equal(store.getRunBudget(task.id).webSearchCalls, 3, '自增累计');

    assert.equal(store.upsertRunBudget(task.id, { wallTimeMs: 9 }, { attempt }), true);
    assert.equal(store.getRunBudget(task.id).webSearchCalls, 3, '快照写入不得覆盖累计计数');

    assert.equal(store.addRunBudgetWebSearchCalls(task.id, -5, { attempt }), true, '负增量被钳制为 0');
    assert.equal(store.getRunBudget(task.id).webSearchCalls, 3);
  } finally {
    cleanup();
  }
});
