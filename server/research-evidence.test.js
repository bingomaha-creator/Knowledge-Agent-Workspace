import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleResearchEvidence } from './research-evidence.js';

test('assembler creates multiple bounded passages with one shared source citation', () => {
  const result = assembleResearchEvidence({
    sources: [{
      id: 'openhands',
      title: 'OpenHands',
      kind: 'web',
      url: 'https://github.com/All-Hands-AI/OpenHands',
      source: 'web',
      sourceType: 'repository',
      provenance: 'candidate_primary',
      selectedFor: 'OpenHands 如何执行任务和验证结果？',
      queries: ['OpenHands 如何执行任务和验证结果？'],
      snippet: 'OpenHands is a software development platform.'
    }],
    documents: [{
      sourceId: 'openhands',
      readerKind: 'github_readme',
      content: [
        'OpenHands agents can modify code, run commands, and work with software repositories during a task.',
        '',
        'The project documentation describes evaluation and testing workflows for software development agents.'
      ].join('\n')
    }]
  });

  assert.equal(result.citations.length, 1);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every((item) => item.citationNumber === 1));
  assert.ok(result.evidence.every((item) => item.passage.length <= 1600));
  assert.equal(result.diagnostics.readPassageCount, 2);
});

test('assembler falls back to a discovery snippet when a source cannot be read', () => {
  const result = assembleResearchEvidence({
    sources: [{
      id: 'page',
      title: 'Page',
      kind: 'web',
      source: 'web',
      snippet: 'This sufficiently detailed discovery snippet remains bounded fallback evidence.',
      queries: ['fallback evidence']
    }],
    documents: []
  });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].readerKind, 'search_snippet');
  assert.equal(result.diagnostics.snippetFallbackCount, 1);
});
