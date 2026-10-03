import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../app.js';
import { createResearchNewRouter } from './routes.js';
import { adjacentSection } from './domain.js';

test('adjacent context stays in its section, retains exact offsets and rejects ambiguous anchors', () => {
  const passage = '这是被检索命中的原文片段，需要上下文解释具体职责。';
  const document = { id: 'doc', name: 'A', knowledgeBaseId: 'kb-a',
    content: `## 前章\n不应读取的内容\n## 当前章\n前文解释\n${passage}\n后文规则\n## 后章\n不应读取的内容` };
  const context = adjacentSection(document, passage);
  assert.equal(context.snippet, `## 当前章\n前文解释\n${passage}\n后文规则\n`);
  assert.equal(document.content.slice(context.offset, context.endOffset), context.snippet);
  assert.deepEqual(adjacentSection(document, `# 文档标题\n## 章节父标题\n### 当前章\n\n${passage}`), context);
  const spaced = { ...document, content: `## 当前章\n原文规定 state owner 应有明确边界，不能重复存储状态。\n后文规则` };
  assert.ok(adjacentSection(spaced, '原文规定stateowner应有明确边界，不能重复存储状态。'));
  assert.equal(adjacentSection(document, '不存在的原文，不能猜测位置，也不能扩大读取范围。'), null);
  assert.equal(adjacentSection({ ...document, content: `${passage}\n${passage}` }, passage), null);
  assert.equal(adjacentSection({ ...document, content: `${passage}\n${passage.split('').join(' ')}` }, passage), null);
  const large = adjacentSection({ ...document, content: `${'前'.repeat(6000)}${passage}${'后'.repeat(6000)}` }, passage);
  assert.ok(large.snippet.length <= 3200);
});

test('Sidecar adjacent context uses published frozen scope and rejects cancelled runs', async (t) => {
  const values = fixture();
  const passage = '命中的原文片段必须足够明确，允许定位同章节上下文。';
  values.knowledgeStore.listDocuments = () => [
    { id: 'doc-a', knowledgeBaseId: 'kb-a', name: 'A', documentType: 'generic', status: 'ready', publicationStatus: 'published', content: `## 章节\n${passage}\n补充规则` },
    { id: 'foreign', knowledgeBaseId: 'kb-b', name: 'B', documentType: 'generic', status: 'ready', publicationStatus: 'published', content: passage },
    { id: 'draft', knowledgeBaseId: 'kb-a', name: 'D', documentType: 'generic', status: 'ready', publicationStatus: 'draft', content: passage }
  ];
  const run = values.store.create({ mode: 'hybrid', knowledgeBaseIds: ['kb-a'], diagnostics: { engine: 'sidecar', retrievalBackend: 'workspace' } });
  run.status = 'running';
  const server = await listen(createApp({ researchNewRouter: createResearchNewRouter(values) }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (ids) => fetch(`http://127.0.0.1:${server.address().port}/api/research-new/${run.id}/retrieval`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextSources: ids.map((documentId) => ({ documentId, passage, sourceId: 'chunk-a' })) }) });
  assert.equal((await (await request(['doc-a'])).json()).evidence[0].anchorSourceId, 'chunk-a');
  assert.deepEqual((await (await request(['foreign', 'draft'])).json()).evidence, []);
  assert.equal((await request(['doc-a', 'doc-a', 'doc-a'])).status, 400);
  run.cancelRequested = true;
  assert.equal((await request(['doc-a'])).status, 409);
});

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

test('Sidecar retrieval uses persisted Knowledge scope and rejects inactive runs', async (t) => {
  const values = fixture();
  const calls = [];
  const run = values.store.create({ mode: 'hybrid', knowledgeBaseIds: ['kb-a'],
    diagnostics: { engine: 'sidecar', retrievalBackend: 'workspace' } });
  run.status = 'running';
  const server = await listen(createApp({ researchNewRouter: createResearchNewRouter({ ...values,
    knowledgeSearch: { async searchEvidence(input) { calls.push(input); return { evidence: [] }; } } }) }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/research-new/${run.id}/retrieval`;
  const request = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test', knowledgeBaseIds: ['foreign'] }) });
  assert.equal((await request()).status, 200);
  assert.deepEqual(calls[0].knowledgeBaseIds, ['kb-a']);
  run.cancelRequested = true;
  assert.equal((await request()).status, 409);
  assert.equal(calls.length, 1);
});

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
      engine: 'sidecar'
    }
  });

  const created = await fetch(`${baseUrl}/api/research-new`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '结合项目调查公开方案', mode: 'hybrid', knowledgeBaseIds: ['kb-a'] })
  });
  assert.equal(created.status, 202);
  const createdRun = (await created.json()).run;
  assert.equal(createdRun.id, 'research-new-1');
  assert.equal(createdRun.engine, 'sidecar');
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
