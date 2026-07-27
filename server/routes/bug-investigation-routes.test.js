import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { createBugInvestigationRouter } from './bug-investigation-routes.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

test('Bug Investigation HTTP adapter maps the explicit investigation lifecycle', async (t) => {
  const calls = [];
  const base = {
    id: 'investigation-1',
    projectRef: 'project-1',
    title: 'TypeError',
    status: 'draft'
  };
  const investigationService = {
    list: (input) => {
      calls.push(['list', input]);
      return [base];
    },
    get: (id) => ({ ...base, id }),
    create: async (input) => {
      calls.push(['create', input]);
      return base;
    },
    appendEvidence: (id, input) => {
      calls.push(['append', id, input]);
      return base;
    },
    analyze: async (id) => {
      calls.push(['analyze', id]);
      return base;
    },
    convertToCandidate: async (id) => {
      calls.push(['convert', id]);
      return { ...base, status: 'converted', candidateBugCaseId: 'candidate-1' };
    },
    close: (id) => {
      calls.push(['close', id]);
      return { ...base, status: 'closed' };
    }
  };
  const router = createBugInvestigationRouter({ investigationService });
  const server = await listen(createApp({ bugInvestigationRouter: router }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${port}/api/bug-investigations`;

  const created = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectRef: 'project-1',
      title: 'TypeError',
      evidence: {
        type: 'code',
        content: 'throw new TypeError()',
        metadata: { fileName: 'src/a.ts', language: 'TypeScript', ignored: 'x' }
      },
      reviewStatus: 'confirmed'
    })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(calls[0][1], {
    projectRef: 'project-1',
    title: 'TypeError',
    evidence: {
      type: 'code',
      content: 'throw new TypeError()',
      metadata: { fileName: 'src/a.ts', language: 'TypeScript' }
    }
  });

  await fetch(`${endpoint}/investigation-1/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'reproduction', content: '点击发送' })
  });
  await fetch(`${endpoint}/investigation-1/analyze`, { method: 'POST' });
  const converted = await fetch(`${endpoint}/investigation-1/convert`, { method: 'POST' });
  assert.equal((await converted.json()).investigation.candidateBugCaseId, 'candidate-1');
  assert.deepEqual(calls.map((call) => call[0]), ['create', 'append', 'analyze', 'convert']);
});
