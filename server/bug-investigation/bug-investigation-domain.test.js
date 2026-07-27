import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCandidateReadiness,
  evaluateEvidenceQuality,
  extractBugFacts,
  normalizeBugEvidenceInput,
  sanitizeBugEvidence
} from './bug-investigation-domain.js';

test('sanitizer removes high-confidence credentials before evidence leaves the domain seam', () => {
  const result = sanitizeBugEvidence(`
AxiosError: Request failed
Authorization: Bearer abc.def.secret
Cookie: session=super-secret
GET /api/me?access_token=query-secret
api_key="bocha-secret"
jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123
  `);

  assert.equal(result.content.includes('super-secret'), false);
  assert.equal(result.content.includes('query-secret'), false);
  assert.equal(result.content.includes('bocha-secret'), false);
  assert.match(result.content, /\[REDACTED/);
  assert.ok(result.redactions.length >= 3);
});

test('deterministic parser extracts facts without claiming a root cause', () => {
  const evidence = [{
    id: 'evidence-1',
    type: 'error',
    content: `TypeError: Cannot read properties of undefined
at sendMessage (src/stores/chat.ts:182:14)
at ChatPanel.vue:90:3
Vue Pinia browser`,
    metadata: { fileName: '', language: 'TypeScript', lineStart: null }
  }, {
    id: 'evidence-2',
    type: 'reproduction',
    content: '连续发送两个流式请求',
    metadata: { fileName: '', language: '', lineStart: null }
  }];
  const facts = extractBugFacts(evidence);
  const gate = evaluateEvidenceQuality(facts, evidence);

  assert.deepEqual(facts.errorTypes, ['TypeError']);
  assert.ok(facts.files.includes('src/stores/chat.ts'));
  assert.ok(facts.frameworks.includes('Vue'));
  assert.ok(facts.frameworks.includes('Pinia'));
  assert.deepEqual(facts.reproductionSteps, ['连续发送两个流式请求']);
  assert.equal('rootCause' in facts, false);
  assert.equal(gate.quality, 'sufficient');
});

test('frontend fact parser recognizes open error names and codes without indexing code as signatures', () => {
  const evidence = [{
    id: 'evidence-error',
    type: 'error',
    content: [
      'Uncaught ChunkLoadError: Loading chunk settings failed.',
      'at loadRoute (src/router/lazy.ts:42:7)',
      'GET /assets/settings.js net::ERR_ABORTED 404 (Not Found)',
      'TS2322: Type undefined is not assignable to type RouteRecordRaw'
    ].join('\n'),
    metadata: { fileName: '', language: 'TypeScript', lineStart: null }
  }, {
    id: 'evidence-code',
    type: 'code',
    content: [
      'const errorState = computed(() => store.error);',
      'const result = await loadRoute();'
    ].join('\n'),
    metadata: { fileName: 'src/router/lazy.ts', language: 'TypeScript', lineStart: 38 }
  }];

  const facts = extractBugFacts(evidence);

  assert.ok(facts.errorTypes.includes('ChunkLoadError'));
  assert.ok(facts.errorCodes.includes('ERR_ABORTED'));
  assert.ok(facts.errorCodes.includes('TS2322'));
  assert.ok(facts.locations.includes('src/router/lazy.ts:42:7'));
  assert.equal(
    facts.errorSignatures.some((signature) => signature.includes('const errorstate')),
    false
  );
});

test('evidence gate stops vague reports and candidate gate requires technical context', () => {
  const normalized = normalizeBugEvidenceInput({
    type: 'note',
    content: '页面打不开了'
  });
  const evidence = [{
    id: 'evidence-vague',
    ...normalized,
    createdAt: 1
  }];
  const facts = extractBugFacts(evidence);

  assert.equal(evaluateEvidenceQuality(facts, evidence).quality, 'insufficient');
  const readiness = evaluateCandidateReadiness(facts, evidence);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.checks.some((check) => check.key === 'context' && !check.passed));
});
