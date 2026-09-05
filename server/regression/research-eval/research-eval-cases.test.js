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
import { createFixtureAdapters, runEvalCase } from './harness.js';
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
      const metrics = await runEvalCase({
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

      const replayed = await runEvalCase({
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
