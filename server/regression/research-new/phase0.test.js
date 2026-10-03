import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateResearchNewCases, hashResearchNewCaseSet } from './case-set.js';
import { RESEARCH_NEW_METRICS, safeRatio } from './metrics.js';

const casesUrl = new URL('./cases.json', import.meta.url);

test('Research New Phase 0 case 集覆盖 Web/Hybrid 与关键失败路径', async () => {
  const cases = JSON.parse(await readFile(casesUrl, 'utf8'));
  validateResearchNewCases(cases);
  assert.equal(cases.length, 10);
  assert.ok(cases.some((item) => item.mode === 'web'));
  assert.ok(cases.some((item) => item.mode === 'hybrid'));
  assert.ok(cases.some((item) => item.id === 'web-no-results'));
  assert.ok(cases.some((item) => item.id === 'web-reader-failure'));
  assert.ok(cases.some((item) => item.id === 'web-replan-success'));
  assert.ok(cases.some((item) => item.id === 'hybrid-project-conflict'));
  assert.match(hashResearchNewCaseSet(cases), /^[a-f0-9]{64}$/);
});

test('Research New 指标显式区分正文、snippet、血统和 Replan 增益', () => {
  for (const metric of [
    'requiredTrackCoverage',
    'fullTextEvidenceRate',
    'snippetEvidenceRate',
    'citationValidityRate',
    'lineageCompletenessRate',
    'replanCoverageDelta',
    'unresolvedDisclosureRate',
    'sourceOriginIntegrityRate'
  ]) {
    assert.equal(typeof RESEARCH_NEW_METRICS[metric], 'string');
  }
  assert.equal(safeRatio(3, 4), 0.75);
  assert.equal(safeRatio(0, 0), null);
});

test('case 校验拒绝没有知识 fixture 的 Hybrid case', () => {
  assert.throws(() => validateResearchNewCases(Array.from({ length: 8 }, (_, index) => ({
    id: `case-${index}`,
    mode: index === 0 ? 'hybrid' : 'web',
    question: '问题',
    requiredDimensions: ['维度'],
    preferredSourceTraits: ['来源'],
    allowedUnresolvedWhen: ['条件'],
    forbiddenUnsupportedClaims: ['禁止结论']
  }))), /knowledgeFixture/);
});
