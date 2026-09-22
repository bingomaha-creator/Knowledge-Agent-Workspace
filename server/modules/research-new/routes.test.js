import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../app.js';
import { createResearchNewRouter } from './routes.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function fixture() {
  const runs = new Map();
  const queued = [];
  const store = {
    list: () => [...runs.values()],
    get: (id) => runs.get(id) || null,
    create(input) {
      const run = { id: 'research-new-1', status: 'queued', ...input };
      runs.set(run.id, run);
      return run;
    }
  };
  const worker = {
    async enqueue(id) { queued.push(id); },
    cancel(id) {
      const run = runs.get(id);
      return run ? { ...run, status: 'cancelled' } : null;
    }
  };
  const knowledgeStore = {
    getKnowledgeBase: (id) => id === 'kb-a' ? { id } : null,
    listDocuments: (ids) => ids.includes('kb-a')
      ? [{ status: 'ready', publicationStatus: 'published' }]
      : []
  };
  return { store, worker, knowledgeStore, queued };
}

test('Research New HTTP 提供能力、创建、详情、列表和取消合同', async (t) => {
  const values = fixture();
  const router = createResearchNewRouter({
    ...values,
    modelConfigured: true,
    webSearchConfigured: true,
    webSearchCapabilities: {
      provider: 'tavily', fullText: true, domainFilter: true, temporalFilter: true
    },
    webReaderTransport: 'tavily_raw_content'
  });
  const server = await listen(createApp({ researchNewRouter: router }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const capabilities = await fetch(`${baseUrl}/api/research-new/capabilities`);
  assert.deepEqual(await capabilities.json(), {
    capabilities: {
      model: true,
      webSearch: true,
      webSearchProvider: {
        name: 'tavily', fullText: true, domainFilter: true, temporalFilter: true
      },
      webReader: { configured: true, transport: 'tavily_raw_content' },
      modes: ['web', 'hybrid'],
      targetedReplan: true,
      engine: 'node'
    }
  });

  const created = await fetch(`${baseUrl}/api/research-new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '结合项目调查公开方案', mode: 'hybrid', knowledgeBaseIds: ['kb-a'] })
  });
  assert.equal(created.status, 202);
  assert.equal((await created.json()).run.id, 'research-new-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(values.queued, ['research-new-1']);

  assert.equal((await (await fetch(`${baseUrl}/api/research-new`)).json()).runs.length, 1);
  assert.equal((await (await fetch(`${baseUrl}/api/research-new/research-new-1`)).json()).run.id, 'research-new-1');
  assert.equal((await fetch(`${baseUrl}/api/research-new/missing`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/research-new/research-new-1/cancel`, { method: 'POST' })).status, 200);
});

test('Research New 创建校验模型、模式与 Hybrid 可检索范围', async (t) => {
  const values = fixture();
  const unavailable = await listen(createApp({
    researchNewRouter: createResearchNewRouter({ ...values, modelConfigured: false })
  }));
  t.after(() => new Promise((resolve) => unavailable.close(resolve)));
  const unavailableResponse = await fetch(`http://127.0.0.1:${unavailable.address().port}/api/research-new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '问题', mode: 'web' })
  });
  assert.equal(unavailableResponse.status, 503);

  const server = await listen(createApp({
    researchNewRouter: createResearchNewRouter({ ...values, modelConfigured: true })
  }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const webScope = await fetch(`${baseUrl}/api/research-new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '问题', mode: 'web', knowledgeBaseIds: ['kb-a'] })
  });
  assert.equal((await webScope.json()).code, 'RESEARCH_NEW_WEB_SCOPE_INVALID');
  const emptyHybrid = await fetch(`${baseUrl}/api/research-new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '问题', mode: 'hybrid', knowledgeBaseIds: [] })
  });
  assert.equal((await emptyHybrid.json()).code, 'RESEARCH_NEW_KNOWLEDGE_REQUIRED');
});
