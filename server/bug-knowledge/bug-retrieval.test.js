import assert from 'node:assert/strict';
import test from 'node:test';
import { createBugQuery, matchExactBugSignatures } from './bug-query.js';
import { rankBugCases } from './bug-ranker.js';

function bugCase(id, overrides = {}) {
  return {
    id,
    sourceProjectRef: 'project-current',
    title: id,
    symptom: `${id} symptom`,
    errorSignatures: [],
    context: { language: '', framework: '', versions: [], module: '', environment: '' },
    ...overrides
  };
}

test('Bug query extracts stable signatures and evaluates framework/version compatibility', () => {
  const query = createBugQuery({
    query: 'TypeError: Failed at /Users/me/App.vue:42:7\n    at setupComponent (runtime.js:99)',
    filters: { framework: 'Vue', versions: ['3.5.13'] }
  });
  assert.ok(query.signatures.includes('typeerror: failed at <path>/app.vue:<n>:<n>'));
  assert.ok(query.symbols.includes('setupcomponent'));

  const matches = matchExactBugSignatures(query, [
    bugCase('vue', {
      errorSignatures: ['typeerror: failed at <path>/app.vue:<n>:<n>'],
      context: { framework: 'Vue', versions: ['3.5.13'] }
    }),
    bugCase('react', {
      errorSignatures: ['typeerror: failed at <path>/app.vue:<n>:<n>'],
      context: { framework: 'React', versions: ['18.2.0'] }
    })
  ]);
  assert.deepEqual(matches.map(({ documentId, contextCompatible }) => ({
    documentId,
    contextCompatible
  })), [
    { documentId: 'vue', contextCompatible: true },
    { documentId: 'react', contextCompatible: false }
  ]);
});

test('Bug query accepts long code context without treating it as one Error Signature', () => {
  const longCodeLine = `const serializedState = "${'x'.repeat(2_500)}";`;
  const query = createBugQuery({
    query: [
      'ValueError: some parameters appear in more than one parameter group',
      longCodeLine
    ].join('\n')
  });

  assert.ok(query.normalizedText.includes('valueerror'));
  assert.ok(query.signatures.includes(
    'valueerror: some parameters appear in more than one parameter group'
  ));
  assert.equal(query.signatures.some((signature) => signature.includes('serializedstate')), false);
});

test('Bug ranking collapses chunks per document and fuses exact, FTS, and vector ranks with RRF', () => {
  const cases = [bugCase('bug-a'), bugCase('bug-b')];
  const ranked = rankBugCases({
    bugCases: cases,
    exactMatches: [
      { documentId: 'bug-a', rank: 1, fullSignature: true, contextCompatible: true }
    ],
    keywordMatches: [
      { documentId: 'bug-b', chunk: { id: 'b-1', text: 'b first' }, rank: 1 },
      { documentId: 'bug-a', chunk: { id: 'a-1', text: 'a first' }, rank: 2 },
      { documentId: 'bug-a', chunk: { id: 'a-2', text: 'a second' }, rank: 3 }
    ],
    vectorMatches: [
      { documentId: 'bug-a', chunk: { id: 'a-3', text: 'a vector' }, rank: 1, vectorScore: 0.91 },
      { documentId: 'bug-b', chunk: { id: 'b-2', text: 'b vector' }, rank: 2, vectorScore: 0.88 }
    ],
    topK: 5
  });

  assert.deepEqual(ranked.results.map((result) => result.bugCase.id), ['bug-a', 'bug-b']);
  assert.deepEqual(ranked.results[0].matchedChannels, ['exact', 'fts', 'vector']);
  assert.equal(ranked.results[0].citations.filter((citation) => citation.id.startsWith('a-')).length, 3);
  assert.equal(ranked.trace.ambiguous, false);
});

test('same full signature without enough context is explicitly ambiguous', () => {
  const cases = [bugCase('bug-vue'), bugCase('bug-react')];
  const ranked = rankBugCases({
    bugCases: cases,
    exactMatches: [
      { documentId: 'bug-vue', rank: 1, fullSignature: true, contextCompatible: null },
      { documentId: 'bug-react', rank: 2, fullSignature: true, contextCompatible: null }
    ],
    keywordMatches: [],
    vectorMatches: [],
    topK: 5
  });
  assert.equal(ranked.trace.ambiguous, true);
  assert.deepEqual(
    new Set(ranked.results.map((result) => result.bugCase.id)),
    new Set(['bug-vue', 'bug-react'])
  );
});
