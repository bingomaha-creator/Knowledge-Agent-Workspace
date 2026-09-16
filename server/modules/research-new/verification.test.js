import assert from 'node:assert/strict';
import test from 'node:test';
import { resultQualityFor, verifyResearchNewDelivery } from './verification.js';

test('交付验证同时检查 citation、source、Track 和 Writer 边界', () => {
  const sources = [{ id: 'source-1' }];
  const evidence = [{ id: 'E1', sourceId: 'source-1', trackId: 'track-1', origin: 'web' }];
  const tracks = [{ id: 'track-1', status: 'answered' }];
  assert.deepEqual(verifyResearchNewDelivery({
    report: '有证据的结论 [E1]', tracks, sources, evidence, writerEvidenceIds: ['E1']
  }).failures, []);
  assert.deepEqual(verifyResearchNewDelivery({
    report: '错误引用 [E99]', tracks, sources, evidence, writerEvidenceIds: []
  }).failures.sort(), ['citation_membership', 'track_citation:track-1', 'writer_input_boundary'].sort());
});

test('零证据只能诚实交付 insufficient', () => {
  const tracks = [{ id: 'track-1', status: 'unresolved' }];
  const verdict = verifyResearchNewDelivery({
    report: '证据不足，当前问题未解决。', tracks, sources: [], evidence: [], writerEvidenceIds: []
  });
  assert.equal(verdict.valid, true);
  assert.equal(resultQualityFor(tracks, []), 'insufficient');
});
