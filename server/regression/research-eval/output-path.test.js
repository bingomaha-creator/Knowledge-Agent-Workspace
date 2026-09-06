/**
 * Phase 0 closeout 的回归测试：--case 子集运行不得触达 canonical baseline，
 * caseId 进入文件名前必须被 slug 消毒（防路径穿越/异常字符）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBaselineOutputPath, slugCaseIds } from './output-path.js';

test('slugCaseIds 折叠非法字符并限制长度', () => {
  assert.equal(slugCaseIds(['web-no-results']), 'web-no-results');
  assert.equal(slugCaseIds(['../../etc/passwd']), 'etc-passwd');
  assert.equal(slugCaseIds(['A B/C']), 'a-b-c');
  assert.equal(slugCaseIds(['x'.repeat(100)]), 'x'.repeat(40));
  assert.equal(slugCaseIds([]), 'partial');
  assert.equal(slugCaseIds(['  ']), 'partial');
});

test('完整 case 集运行解析到 canonical baseline', () => {
  const resolved = resolveBaselineOutputPath({
    baselineDir: '/tmp/baselines',
    partialRun: false,
    caseIds: ['web-full-coverage', 'local-full-coverage'],
    timestamp: new Date('2026-09-05T00:00:00Z')
  });
  assert.equal(resolved.kind, 'canonical');
  assert.equal(resolved.path, '/tmp/baselines/phase0-baseline.json');
});

test('--case 子集运行只能写 diagnostics，且文件名经过 slug', () => {
  const resolved = resolveBaselineOutputPath({
    baselineDir: '/tmp/baselines',
    partialRun: true,
    caseIds: ['../../evil', 'web no results'],
    timestamp: new Date('2026-09-05T00:00:00Z')
  });
  assert.equal(resolved.kind, 'diagnostics');
  assert.ok(resolved.path.startsWith('/tmp/baselines/diagnostics/'), '诊断文件必须位于 diagnostics 目录');
  assert.ok(!resolved.path.includes('..'), '文件名不得包含路径穿越片段');
  assert.match(resolved.path, /_evil_web-no-results\.json$/);
});

test('--case 路径永远不会等于 canonical 路径', () => {
  for (const ids of [['phase0'], ['a', 'b'], []]) {
    const resolved = resolveBaselineOutputPath({
      baselineDir: '/tmp/baselines',
      partialRun: true,
      caseIds: ids,
      timestamp: new Date('2026-09-05T00:00:00Z')
    });
    assert.notEqual(resolved.path, '/tmp/baselines/phase0-baseline.json');
  }
});
