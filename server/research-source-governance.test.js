import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyResearchSource,
  scoreResearchSource
} from './research-source-governance.js';

test('a GitHub search result is a repository candidate, not automatically verified official evidence', () => {
  const classification = classifyResearchSource({
    kind: 'web',
    url: 'https://github.com/example/OpenHands-copy',
    sourceKind: 'official_repo'
  });

  assert.equal(classification.sourceType, 'repository');
  assert.equal(classification.provenance, 'candidate_primary');
  assert.ok(classification.reasons.includes('ownership_not_verified'));
});

test('source scoring rewards exact entity, requested source type and provider order', () => {
  const preferred = ['official_repo'];
  const officialCandidate = {
    kind: 'web',
    title: 'OpenHands',
    url: 'https://github.com/All-Hands-AI/OpenHands',
    snippet: 'OpenHands is a platform for software development agents.',
    providerRank: 1
  };
  const generic = {
    kind: 'web',
    title: 'AI Agent roundup',
    url: 'https://example.test/roundup',
    snippet: 'A generic collection of autonomous agent projects.',
    providerRank: 1
  };

  const left = scoreResearchSource('OpenHands 如何编辑代码？', officialCandidate, preferred);
  const right = scoreResearchSource('OpenHands 如何编辑代码？', generic, preferred);
  assert.equal(left.exactEntity, true);
  assert.equal(left.preferredSourceType, true);
  assert.ok(left.qualityScore > right.qualityScore);
});

test('local scoped knowledge is represented as verified project evidence', () => {
  assert.deepEqual(classifyResearchSource({ kind: 'local' }), {
    sourceType: 'project_knowledge',
    provenance: 'verified_primary',
    confidence: 1,
    reasons: ['scoped_project_knowledge']
  });
});
