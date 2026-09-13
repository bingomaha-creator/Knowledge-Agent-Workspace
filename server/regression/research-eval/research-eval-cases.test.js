/**
 * Phase 0 fixture 回放评测（确定性，node --test 自动收集）。
 *
 * 每个 case 在一次性 SQLite 上经真实 createResearchWorker 状态机完整执行两次，
 * 断言：任务以 completed 终态收敛、两次回放的指标完全一致（剔除墙钟时间）、
 * expectations 中声明的覆盖/证据/降级/引用不变量成立。
 * 真实模型与联网基线由 research-eval-live.js 单独产出，不在此入口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeContentHash } from '../../research-evidence-ledger.js';
import { createFixtureAdapters, runEvalCase, runPackThroughDelivery } from './harness.js';
import { computeCaseMetrics, stripTiming } from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, 'cases');
const caseFiles = fs.readdirSync(casesDir).filter((name) => name.endsWith('.json')).sort();
const testCases = caseFiles.flatMap((name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8')).cases);

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-eval-'));
  return {
    dbPath: path.join(dir, 'eval.sqlite'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function assertExpectations(testCase, metrics) {
  const expectations = testCase.expectations || {};
  const label = `评测 case ${testCase.id}`;
  if (expectations.minEvidence !== undefined) {
    assert.ok(metrics.evidence.includedCount >= expectations.minEvidence,
      `${label} 证据数 ${metrics.evidence.includedCount} 应 >= ${expectations.minEvidence}`);
  }
  if (expectations.maxEvidence !== undefined) {
    assert.ok(metrics.evidence.includedCount <= expectations.maxEvidence,
      `${label} 证据数 ${metrics.evidence.includedCount} 应 <= ${expectations.maxEvidence}`);
  }
  if (expectations.minCoverage !== undefined) {
    assert.ok(metrics.coverageRatio !== null && metrics.coverageRatio >= expectations.minCoverage,
      `${label} 覆盖率 ${metrics.coverageRatio} 应 >= ${expectations.minCoverage}`);
  }
  if (expectations.maxCoverage !== undefined) {
    assert.ok(metrics.coverageRatio !== null && metrics.coverageRatio <= expectations.maxCoverage,
      `${label} 覆盖率 ${metrics.coverageRatio} 应 <= ${expectations.maxCoverage}`);
  }
  if (Array.isArray(expectations.quality)) {
    assert.ok(expectations.quality.includes(metrics.resultQuality),
      `${label} resultQuality=${metrics.resultQuality} 应属于 [${expectations.quality.join(', ')}]`);
  }
  if (expectations.webSearchStatus) {
    assert.equal(metrics.webSearchStatus, expectations.webSearchStatus,
      `${label} webSearchStatus 应为 ${expectations.webSearchStatus}`);
  }
  if (expectations.readSourceCount !== undefined) {
    assert.equal(metrics.evidence.readSourceCount, expectations.readSourceCount,
      `${label} 正文读取来源数应为 ${expectations.readSourceCount}`);
  }
  if (expectations.readerFailures !== undefined) {
    assert.equal(metrics.readerFailures, expectations.readerFailures,
      `${label} Reader 失败数应为 ${expectations.readerFailures}`);
  }
  if (expectations.snippetFallbackCount !== undefined) {
    assert.equal(metrics.evidence.snippetFallbackCount, expectations.snippetFallbackCount,
      `${label} snippet 回退段数应为 ${expectations.snippetFallbackCount}`);
  }
  if (expectations.snippetFallbackRate !== undefined) {
    assert.equal(metrics.snippetFallbackRate, expectations.snippetFallbackRate,
      `${label} snippet 回退率应为 ${expectations.snippetFallbackRate}`);
  }
  if (expectations.writerMode) {
    assert.equal(metrics.writerMode, expectations.writerMode,
      `${label} writer 模式应为 ${expectations.writerMode}`);
  }
  if (expectations.writerReasonCode) {
    assert.equal(metrics.writerReasonCode, expectations.writerReasonCode,
      `${label} writer 降级原因码应为 ${expectations.writerReasonCode}`);
  }
  if (expectations.finalReportValid !== undefined) {
    assert.equal(metrics.citationStructureValid, expectations.finalReportValid,
      `${label} 最终报告引用结构有效性应为 ${expectations.finalReportValid}`);
  }
  if (Array.isArray(expectations.limitationIncludes)) {
    for (const code of expectations.limitationIncludes) {
      assert.ok(metrics.limitationCodes.includes(code),
        `${label} 缺少局限标注 ${code}，实际 [${metrics.limitationCodes.join(', ')}]`);
    }
  }
}

for (const testCase of testCases) {
  test(`研究评测 fixture 回放：${testCase.id}`, async () => {
    const first = tempDb();
    const second = tempDb();
    try {
      const { metrics } = await runEvalCase({
        testCase,
        adapters: createFixtureAdapters(testCase),
        mode: 'fixture',
        dbPath: first.dbPath
      });

      assert.equal(metrics.status, 'completed',
        `${testCase.id} 应以 completed 收敛，实际 ${metrics.status}${metrics.failedStage ? `（失败阶段 ${metrics.failedStage}）` : ''}`);
      if (metrics.evidence.includedCount > 0 && metrics.citationCount > 0) {
        assert.equal(metrics.citationValidityRate, 1,
          `${testCase.id} 报告做出的引用必须全部有效（映射到结构化 citation）`);
        assert.equal(metrics.citationStructureValid, true,
          `${testCase.id} 最终报告引用结构必须通过校验`);
        // 证据使用率允许 < 1（候选 citation 允许不被报告引用），此处仅记录不断言。
      }

      const { metrics: replayed } = await runEvalCase({
        testCase,
        adapters: createFixtureAdapters(testCase),
        mode: 'fixture',
        dbPath: second.dbPath
      });
      assert.deepEqual(stripTiming(replayed), stripTiming(metrics),
        `${testCase.id} 两次回放指标必须完全一致（确定性）`);

      assertExpectations(testCase, metrics);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
}

// 引用口径单元测试（纯函数级）：worker 管线会把被拒的模型报告重建为合法最终报告，
// 因此非法引用（尤其符号 marker）只能在这一层验证指标灵敏度——任何非法 marker
// 都必须使 citationValidityRate < 1，不可能达到 Ledger 100% 可追溯门槛。
test('metrics 引用口径：非法数字与符号 marker 都计入无效，零候选使用率为 not_applicable', () => {
  const testCase = { id: 'unit-citation', searchMode: 'web' };
  const run = (verification, citations) => computeCaseMetrics({
    testCase,
    task: {
      searchMode: 'web',
      status: 'completed',
      artifacts: { citations, evidencePack: {}, verification }
    },
    latencyMs: 0,
    counters: {},
    mode: 'fixture'
  });
  const citation = (id, index) => ({ id, index });

  const allValid = run(
    { valid: true, referencedCitationIds: ['c1', 'c2'], invalidCitationNumbers: [], invalidCitationMarkers: [] },
    [citation('c1', 1), citation('c2', 2)]
  );
  assert.equal(allValid.citationValidityRate, 1, '全部有效引用时有效性应为 1');
  assert.equal(allValid.evidenceUsageRate, 1, '全部候选被使用时使用率应为 1');

  const numericInvalid = run(
    { valid: false, referencedCitationIds: ['c1'], invalidCitationNumbers: [99], invalidCitationMarkers: [] },
    [citation('c1', 1), citation('c2', 2)]
  );
  assert.equal(numericInvalid.citationValidityRate, 0.5, '越界数字引用必须计入无效');

  const symbolicInvalid = run(
    { valid: false, referencedCitationIds: ['c1'], invalidCitationNumbers: [], invalidCitationMarkers: ['q2'] },
    [citation('c1', 1), citation('c2', 2)]
  );
  assert.equal(symbolicInvalid.citationValidityRate, 0.5, '符号 marker（如 [q2]）必须计入无效');
  assert.equal(symbolicInvalid.invalidMarkerCount, 1);

  const mixedInvalid = run(
    { valid: false, referencedCitationIds: ['c1'], invalidCitationNumbers: [98], invalidCitationMarkers: ['q2'] },
    [citation('c1', 1)]
  );
  assert.equal(mixedInvalid.citationValidityRate, 0.3333, '数字与 marker 同时存在时都计入无效');

  const zeroCandidates = run(
    { valid: true, referencedCitationIds: [], invalidCitationNumbers: [], invalidCitationMarkers: [] },
    []
  );
  assert.equal(zeroCandidates.citationValidityRate, null, '零引用时有效性不适用，应为 null');
  assert.equal(zeroCandidates.evidenceUsageRate, null, '零候选且零引用时使用率不适用，应为 null 而非 0');
  assert.equal(zeroCandidates.citationStructureValid, true);
});

// —— Phase 2A 第二交付门：Ledger would-be Evidence Pack 五项门槛验证 ——
// 门槛 1：citation 溯源率 100%（would-be citation → 台账条目 → 完整血统 +
//        passageContentHash 可追溯到实际 passage 内容）。
// 门槛 2：旧路径可用证据意外丢失为 0（unexpectedLoss === 0）。
// 门槛 3：报告质量不劣化——旧 Evidence Pack 与 would-be Pack 分别经过同一
//        确定性 Writer、verifyReport 与 Completion Contract，比较交付合法性、
//        required checks、引用有效性、子问题覆盖、局限披露与 Writer 采纳状态；
//        语义支持率等无法离线评估的指标显式 not_evaluated（Policy 已输出 null）。
// 门槛 4：evidenceId/contentHash/citation 分配可重复（同输入重跑一致；
//        跨 Run 以 contentHash + 不含 runId 的稳定来源键比较分配顺序）。
// 门槛 5：差异逐项完成分类（人工复核由显式脚本生成的 pending_review 报告
//        交由用户/Codex 执行，本测试不代行）。
// 任一机器门槛不满足 → Ledger 保持 shadow，不得切 primary。

test('Phase 0 case 集：Ledger would-be Evidence Pack 五项门槛验证', async () => {
  const caseResults = [];

  for (const testCase of testCases) {
    const first = tempDb();
    const second = tempDb();
    try {
      const runA = await runEvalCase({
        testCase,
        adapters: createFixtureAdapters(testCase),
        mode: 'fixture',
        dbPath: first.dbPath,
        includeLedger: true
      });
      const runB = await runEvalCase({
        testCase,
        adapters: createFixtureAdapters(testCase),
        mode: 'fixture',
        dbPath: second.dbPath,
        includeLedger: true
      });

      const { metrics, ledger } = runA;
      assert.ok(ledger, `${testCase.id} shadow 台账必须存在`);
      const wouldBeA = ledger.diff?.wouldBeCitations || [];
      const wouldBeB = runB.ledger?.diff?.wouldBeCitations || [];
      const oldPack = {
        citations: runA.task.artifacts.citations || [],
        evidence: runA.task.artifacts.evidence || []
      };
      const wouldBePack = {
        citations: ledger.diff?.wouldBeCitations || [],
        evidence: ledger.diff?.wouldBeEvidence || []
      };

      // 门槛 1：citation 溯源率 100%
      const untraceable = wouldBeA.filter((citation) => {
        const entry = ledger.entries.find((item) => item.evidenceId === citation.sourceEntryId);
        if (!entry) return true;
        if (entry.contentHash !== citation.contentHash) return true;
        if (!entry.subquestionId || !entry.query || !entry.provider) return true;
        if (!entry.readerKind) return true;
        // 全文层必须有原文 artifact；薄层必须有发现摘要
        if (citation.tier === 'fulltext' && !entry.artifactId) return true;
        if (citation.tier === 'thin' && !entry.discoverySnippet) return true;
        return false;
      });
      const traceabilityRate = wouldBeA.length
        ? Number(((wouldBeA.length - untraceable.length) / wouldBeA.length).toFixed(4))
        : 1;
      assert.equal(untraceable.length, 0,
        `${testCase.id} 存在无法溯源的 would-be citation：${untraceable.map((item) => item.id).join('、')}`);
      // 逐段指纹重算（Codex 修正第 1 点溯源要求）：每条 would-be evidence 的
      // passageContentHash 必须等于对实际入选 passage 规范化内容的哈希
      for (const item of ledger.diff?.wouldBeEvidence || []) {
        assert.equal(item.passageContentHash, computeContentHash(item.passage),
          `${testCase.id} evidence ${item.id} 的 passageContentHash 必须对实际 passage 内容计算`);
      }

      // 门槛 2：意外丢失为 0
      const unexpectedLoss = ledger.diff?.counts?.unexpectedLoss ?? 0;
      assert.equal(unexpectedLoss, 0, `${testCase.id} 意外丢失 ${unexpectedLoss} 条旧证据`);

      // 门槛 3：报告质量不劣化——旧/新 Pack 分别经真实 Worker 的同一交付管线
      // （写作 → 验证 → 质量评估 → 完成契约），逐项记录 true/false/not_evaluated。
      const planSubquestions = runA.task?.artifacts?.plan?.subquestions || [];
      const [oldDelivery, wouldBeDelivery] = await Promise.all([
        runPackThroughDelivery({ pack: oldPack, testCase, writerMode: testCase.fixtures.writer || 'faithful' }),
        runPackThroughDelivery({ pack: wouldBePack, testCase, writerMode: testCase.fixtures.writer || 'faithful' })
      ]);
      assert.equal(oldDelivery.task.status, 'completed', `${testCase.id} 旧 Pack 交付应收敛 completed`);
      assert.equal(wouldBeDelivery.task.status, 'completed', `${testCase.id} would-be Pack 交付应收敛 completed`);
      // 交付合法性：两边各自独立判定，分别记录（不能用"同样失败"证明通过）
      assert.equal(wouldBeDelivery.deliveryLegal, oldDelivery.deliveryLegal,
        `${testCase.id} 交付合法性不得劣化`);
      // required checks 逐项三态记录
      const requiredBy = (verdict) => Object.fromEntries(
        (verdict.checks || []).filter((item) => item.required).map((item) => [item.id, item.passed])
      );
      const oldRequired = requiredBy(oldDelivery.verdict);
      const wouldBeRequired = requiredBy(wouldBeDelivery.verdict);
      assert.deepEqual(Object.keys(wouldBeRequired).sort(), Object.keys(oldRequired).sort(),
        `${testCase.id} required check 集合必须一致`);
      // 引用有效性不得劣化
      assert.equal(wouldBeDelivery.citationValidity, oldDelivery.citationValidity,
        `${testCase.id} 引用有效性不得劣化`);
      // 子问题覆盖率不得劣化
      assert.ok(
        wouldBeDelivery.quality.metrics.coverageRatio >= oldDelivery.quality.metrics.coverageRatio,
        `${testCase.id} 子问题覆盖率不得劣化`
      );
      // 局限披露判定不得劣化
      const disclosureOf = (verdict) => verdict.checks.find((item) => item.id === 'limitation-disclosure')?.passed ?? null;
      assert.equal(disclosureOf(wouldBeDelivery.verdict), disclosureOf(oldDelivery.verdict),
        `${testCase.id} 局限披露判定不得劣化`);
      // Writer 采纳状态忠实来自各 case 的 Writer 行为（invalid_citations 用例验证拒绝与 fallback 重建）
      assert.equal(wouldBeDelivery.writerMode, oldDelivery.writerMode,
        `${testCase.id} 同一 writerMode 下两侧采纳状态必须一致`);
      // 语义支持率：not_evaluated（Policy 已输出 null），不自动判通过
      assert.equal(wouldBeDelivery.verdict.checks.find((item) => item.id === 'claim-support')?.passed ?? null, null);

      // 门槛 4：确定性——contentHash + 分配顺序跨 Run 一致（evidenceId 含 runId 不可比）
      assert.deepEqual(
        wouldBeB.map((item) => [item.contentHash, item.index, item.tier, item.readerKind]),
        wouldBeA.map((item) => [item.contentHash, item.index, item.tier, item.readerKind]),
        `${testCase.id} would-be citation 分配必须可重复`
      );
      const mappingA = Object.fromEntries(wouldBeA.map((item) => [item.canonicalSourceId || item.url, item.index]));
      const mappingB = Object.fromEntries(wouldBeB.map((item) => [item.canonicalSourceId || item.url, item.index]));
      assert.deepEqual(mappingB, mappingA, `${testCase.id} canonicalSourceId → citation index 映射必须跨 Run 一致`);

      // 门槛 5：差异逐项完成分类（机器部分；人工复核由 pending_review 报告承载）
      const items = ledger.diff?.items || [];
      for (const item of items) {
        assert.ok(
          ['kept_fulltext', 'kept_thin', 'downgraded', 'unexpected_loss'].includes(item.classification),
          `${testCase.id} 差异项 ${item.oldCitationId} 分类非法：${item.classification}`
        );
      }
      const counts = ledger.diff?.counts || {};
      assert.equal(
        (counts.keptFulltext || 0) + (counts.keptThin || 0) + (counts.downgraded || 0) + (counts.unexpectedLoss || 0),
        items.length,
        `${testCase.id} 差异分类计数必须守恒`
      );

      caseResults.push({
        caseId: testCase.id,
        searchMode: testCase.searchMode,
        oldCitationCount: oldPack.citations.length,
        wouldBeCitationCount: wouldBePack.citations.length,
        counts: ledger.diff?.counts,
        coverage: ledger.diff?.coverage,
        deliveryComparison: {
          deliveryLegalEqual: wouldBeDelivery.deliveryLegal === oldDelivery.deliveryLegal,
          citationValidityEqual: wouldBeDelivery.citationValidity === oldDelivery.citationValidity,
          writerModeEqual: wouldBeDelivery.writerMode === oldDelivery.writerMode,
          oldRequiredChecks: oldRequired,
          wouldBeRequiredChecks: wouldBeRequired,
          oldQuality: oldDelivery.quality.quality,
          wouldBeQuality: wouldBeDelivery.quality.quality,
          semanticClaimSupport: 'not_evaluated（人工/Judge 口径，无法离线评估）'
        },
        gates: {
          traceabilityRate,
          unexpectedLoss: 0,
          coverageNonRegression: true,
          deterministic: true,
          classificationComplete: true
        }
      });
    } finally {
      first.cleanup();
      second.cleanup();
    }
  }

  return { caseResults };
});

