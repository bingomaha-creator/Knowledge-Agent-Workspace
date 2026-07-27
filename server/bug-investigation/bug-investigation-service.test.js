import assert from 'node:assert/strict';
import test from 'node:test';
import { createBugInvestigationService } from './bug-investigation-service.js';

function createMemoryStore() {
  const records = new Map();
  return {
    get: (id) => records.get(id) || null,
    list: ({ projectRef } = {}) => [...records.values()]
      .filter((item) => !projectRef || item.projectRef === projectRef),
    create: (input) => {
      const value = structuredClone(input);
      records.set(value.id, value);
      return structuredClone(value);
    },
    update: (id, patch) => {
      const value = { ...records.get(id), ...structuredClone(patch), updatedAt: 999 };
      records.set(id, value);
      return structuredClone(value);
    }
  };
}

function createFixture(overrides = {}) {
  let sequence = 0;
  const calls = {
    search: [],
    analyze: [],
    createCase: []
  };
  const service = createBugInvestigationService({
    store: createMemoryStore(),
    projectExists: async (projectRef) => projectRef === 'project-1',
    searchBugCases: async (input) => {
      calls.search.push(input);
      return {
        results: [{
          bugCase: {
            id: 'case-1',
            title: 'SSE chunk parse',
            symptom: 'Unexpected end',
            scope: 'project',
            sourceProjectRef: 'project-1',
            rootCause: 'Parsed partial chunk',
            fix: 'Buffer event block',
            verification: 'Regression passed',
            reviewStatus: 'confirmed'
          },
          matchedChannels: ['exact'],
          rank: 1,
          score: 0.1
        }],
        trace: { evidenceGap: false, ambiguous: false, degradedChannels: [] }
      };
    },
    analyzeEvidence: async (input) => {
      calls.analyze.push(input);
      return {
        output: {
          summary: '当前错误可能来自不完整 SSE 事件。',
          hypotheses: [{
            title: '不完整 chunk 被直接解析',
            reasoning: '错误与历史案例一致。',
            falsification: '完整事件仍然失败时，该假设不成立。',
            confidenceLabel: 'plausible',
            supportingEvidenceIds: [input.evidence[0].id],
            counterEvidenceIds: [],
            relatedCaseIds: ['case-1']
          }],
          verificationSteps: [{
            title: '记录 buffer',
            instruction: '记录解析前 buffer。',
            supportingSignal: '失败时 buffer 不完整。',
            refutingSignal: '失败时 buffer 始终包含完整事件。'
          }],
          missingEvidence: ['请补充 parseEvent 函数源码。']
        },
        diagnostics: {
          mode: 'model',
          status: 'success',
          reasonCode: '',
          durationMs: 12,
          inputTokens: 100,
          outputTokens: 80
        }
      };
    },
    createBugCase: async (input) => {
      calls.createCase.push(input);
      return { bugCase: { id: 'candidate-1', ...input } };
    },
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => sequence * 10,
    ...overrides
  });
  return { service, calls };
}

test('insufficient evidence never invokes retrieval or model analysis', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: { type: 'note', content: '页面打不开了' }
  });
  const analyzed = await fixture.service.analyze(created.id);

  assert.equal(analyzed.analysis.status, 'insufficient');
  assert.deepEqual(analyzed.analysis.hypotheses, []);
  assert.equal(fixture.calls.search.length, 0);
  assert.equal(fixture.calls.analyze.length, 0);
});

test('multi-turn evidence produces grounded hypotheses and confirmed-case retrieval', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: {
      type: 'error',
      content: 'Unexpected end of JSON input\nat parseEvent (src/sse.ts:42:3)\nVue browser'
    }
  });
  const appended = fixture.service.appendEvidence(created.id, {
    type: 'reproduction',
    content: '连续接收两个被拆分的 SSE chunk'
  });
  assert.equal(appended.analysis.status, 'stale');

  const analyzed = await fixture.service.analyze(created.id);
  assert.equal(analyzed.analysis.status, 'success');
  assert.equal(analyzed.analysis.similarCases[0].id, 'case-1');
  assert.equal(analyzed.analysis.hypotheses[0].confidenceLabel, 'plausible');
  assert.deepEqual(analyzed.analysis.nextAction, {
    title: '执行一次定向验证',
    description: '记录解析前 buffer。',
    evidenceType: 'verification'
  });
  assert.equal(analyzed.candidateReadiness.ready, true);
  assert.equal(fixture.calls.search[0].includeCommon, true);
});

test('analysis summary is deterministic facts instead of the model root-cause narrative', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: {
      type: 'error',
      content: 'Unexpected end of JSON input\nat parseEvent (src/sse.ts:42:3)\nVue browser'
    }
  });

  const analyzed = await fixture.service.analyze(created.id);

  assert.match(analyzed.analysis.summary, /已观察到错误标识/u);
  assert.match(analyzed.analysis.summary, /src\/sse\.ts:42:3/u);
  assert.match(analyzed.analysis.summary, /根因仍待验证/u);
  assert.doesNotMatch(analyzed.analysis.summary, /可能来自不完整 SSE 事件/u);
});

test('limited evidence still prioritizes a blocking evidence gap over verification', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: {
      type: 'error',
      content: 'Unexpected end of JSON input'
    }
  });

  const analyzed = await fixture.service.analyze(created.id);

  assert.equal(analyzed.analysis.evidenceQuality, 'limited');
  assert.deepEqual(analyzed.analysis.nextAction, {
    title: '补充代码上下文',
    description: '请补充 parseEvent 函数源码。',
    evidenceType: 'code'
  });
});

test('candidate conversion is explicit and never promotes model hypotheses to verified root cause', async () => {
  const fixture = createFixture();
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: {
      type: 'error',
      content: 'TypeError: Cannot read properties of undefined\nat send (src/chat.ts:12:3)\nVue browser'
    }
  });
  fixture.service.appendEvidence(created.id, {
    type: 'reproduction',
    content: '连续发送两个请求'
  });
  await fixture.service.analyze(created.id);

  assert.equal(fixture.calls.createCase.length, 0);
  const converted = await fixture.service.convertToCandidate(created.id);
  assert.equal(converted.status, 'converted');
  assert.equal(converted.candidateBugCaseId, 'candidate-1');
  assert.equal(fixture.calls.createCase[0].rootCause, null);
  assert.equal(fixture.calls.createCase[0].sourceRefs[0], `investigation:${created.id}`);
});

test('model failure degrades transparently while preserving deterministic facts and matches', async () => {
  const fixture = createFixture({
    analyzeEvidence: async () => ({
      output: null,
      diagnostics: {
        mode: 'deterministic',
        status: 'degraded',
        reasonCode: 'model_unavailable',
        durationMs: 0
      }
    })
  });
  const created = await fixture.service.create({
    projectRef: 'project-1',
    evidence: {
      type: 'test_failure',
      content: 'TypeError: undefined\nat render (src/App.vue:20:2)\nVitest Vue browser'
    }
  });
  fixture.service.appendEvidence(created.id, {
    type: 'reproduction',
    content: '运行 npm run test:client'
  });
  const analyzed = await fixture.service.analyze(created.id);

  assert.equal(analyzed.analysis.status, 'degraded');
  assert.equal(analyzed.analysis.reasonCode, 'model_unavailable');
  assert.equal(analyzed.analysis.similarCases.length, 1);
  assert.ok(analyzed.facts.files.includes('src/App.vue'));
});
