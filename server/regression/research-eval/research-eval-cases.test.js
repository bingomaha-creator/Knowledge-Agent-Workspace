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
import { stripTiming } from './metrics.js';

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
      if (metrics.evidence.includedCount > 0) {
        assert.equal(metrics.citationTraceableRatio, 1,
          `${testCase.id} 报告引用必须全部可追溯到结构化 citation`);
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
