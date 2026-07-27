import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../app.js';
import { createKnowledgeRouter } from '../routes/knowledge-routes.js';
import { createMemoryRouter } from '../routes/memory-routes.js';
import { createResearchRouter } from '../routes/research-routes.js';
import { createSystemRouter } from '../routes/system-routes.js';
import { createChatRouter } from '../routes/chat-routes.js';
import { createBugKnowledgeRouter } from '../routes/bug-knowledge-routes.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

test('createApp mounts the injected chat router before the SPA fallback', async (t) => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-app-contract-'));
  fs.writeFileSync(path.join(frontendDir, 'index.html'), '<main>frontend fallback</main>');

  const app = createApp({
    frontendDir,
    chatRouter: createChatRouter({
      orchestrator: {
        async run(_request, { emit }) {
          emit({ type: 'done', data: { source: 'chat route' } });
        }
      }
    })
  });
  const server = await listen(app);
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(frontendDir, { recursive: true, force: true });
  });

  const chatResponse = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(chatResponse.status, 200);
  const chatBody = await chatResponse.text();
  assert.match(chatBody, /event: done/);
  assert.match(chatBody, /chat route/);

  const fallbackResponse = await fetch(`http://127.0.0.1:${port}/some/client/route`);
  assert.equal(fallbackResponse.status, 200);
  assert.match(await fallbackResponse.text(), /frontend fallback/);
});

test('system routes preserve health, preset, and run response contracts', async (t) => {
  const calls = [];
  const systemRouter = createSystemRouter({
    presets: [{ id: 'general', name: '通用助手' }],
    runStore: {
      listRuns(options) {
        return [{ id: 'run-1', conversationId: options.conversationId }];
      },
      getRunWithSpans(id) {
        return id === 'run-1' ? { id, spans: [] } : null;
      }
    },
    async callMcpTool(name, args, options) {
      calls.push({ name, args, options });
      return { documents: [{ id: 'doc-1' }] };
    }
  });
  const server = await listen(createApp({ systemRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await fetch(`${baseUrl}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, documents: 1, mcp: true });
  assert.equal(calls[0].name, 'list_knowledge_documents');

  const presets = await fetch(`${baseUrl}/api/presets`);
  assert.deepEqual(await presets.json(), {
    presets: [{ id: 'general', name: '通用助手' }]
  });

  const runs = await fetch(`${baseUrl}/api/runs?conversationId=conversation-1&limit=5`);
  assert.deepEqual(await runs.json(), {
    runs: [{ id: 'run-1', conversationId: 'conversation-1' }]
  });

  const run = await fetch(`${baseUrl}/api/runs/run-1`);
  assert.deepEqual(await run.json(), { run: { id: 'run-1', spans: [] } });

  assert.equal((await fetch(`${baseUrl}/api/runs/missing`)).status, 404);
});

test('research routes preserve validation, queueing, and cancellation contracts', async (t) => {
  const queued = [];
  const tasks = new Map();
  const researchStore = {
    list() {
      return [...tasks.values()];
    },
    get(id) {
      return tasks.get(id) || null;
    },
    create(input) {
      const task = {
        id: 'research-1',
        status: 'queued',
        sessionId: 'research-1',
        parentTaskId: '',
        turnIndex: 1,
        ...input
      };
      tasks.set(task.id, task);
      return task;
    },
    listSession(id) {
      const task = tasks.get(id);
      return task ? [task] : null;
    },
    continueSession(id, input) {
      const parent = tasks.get(id);
      if (!parent) return null;
      const task = {
        ...parent,
        id: 'research-2',
        question: input.question,
        status: 'queued',
        parentTaskId: parent.id,
        turnIndex: 2
      };
      tasks.set(task.id, task);
      return task;
    },
    retry(id) {
      return tasks.get(id) || null;
    }
  };
  const researchRouter = createResearchRouter({
    researchStore,
    researchWorker: {
      cancel(id) {
        const task = tasks.get(id);
        return task ? { ...task, status: 'cancelled' } : null;
      }
    },
    researchKnowledgeStore: {
      getKnowledgeBase(id) {
        return id === 'kb-default' ? { id } : null;
      }
    },
    enqueueResearch(id) {
      queued.push(id);
    },
    normalizeKnowledgeBaseIds(value, fallback) {
      return Array.isArray(value) ? value : fallback;
    },
    webSearchConfigured: false
  });
  const server = await listen(createApp({ researchRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const capabilities = await fetch(`${baseUrl}/api/research/capabilities`);
  assert.deepEqual(await capabilities.json(), {
    capabilities: {
      localKnowledge: true,
      publicPrimarySearch: { available: false, role: 'supplemental' }
    }
  });

  const invalid = await fetch(`${baseUrl}/api/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '', searchMode: 'local' })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'RESEARCH_QUESTION_REQUIRED');

  const created = await fetch(`${baseUrl}/api/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: '梳理取消边界',
      searchMode: 'hybrid',
      knowledgeBaseIds: ['kb-default']
    })
  });
  assert.equal(created.status, 202);
  const createdBody = await created.json();
  assert.equal(createdBody.task.id, 'research-1');
  assert.match(createdBody.notice, /未配置联网检索/);
  assert.deepEqual(queued, ['research-1']);

  const list = await fetch(`${baseUrl}/api/research?status=queued&limit=10`);
  assert.equal((await list.json()).tasks.length, 1);

  const detail = await fetch(`${baseUrl}/api/research/research-1`);
  assert.equal((await detail.json()).task.id, 'research-1');

  const session = await fetch(`${baseUrl}/api/research/research-1/session`);
  assert.equal((await session.json()).runs.length, 1);

  const followUp = await fetch(`${baseUrl}/api/research/research-1/follow-ups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '继续补充公开项目的实现证据' })
  });
  assert.equal(followUp.status, 202);
  assert.equal((await followUp.json()).task.turnIndex, 2);
  assert.deepEqual(queued, ['research-1', 'research-2']);

  const retried = await fetch(`${baseUrl}/api/research/research-1/retry`, {
    method: 'POST'
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(queued, ['research-1', 'research-2', 'research-1']);

  const cancelled = await fetch(`${baseUrl}/api/research/research-1/cancel`, {
    method: 'POST'
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).task.status, 'cancelled');

  assert.equal((await fetch(`${baseUrl}/api/research/missing`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/research/missing/retry`, {
    method: 'POST'
  })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/research/missing/cancel`, {
    method: 'POST'
  })).status, 404);
});

test('knowledge routes keep MCP DTOs and return upload failures as JSON', async (t) => {
  const calls = [];
  const knowledgeRouter = createKnowledgeRouter({
    async callMcpTool(name, args, options) {
      calls.push({ name, args, options });
      if (name === 'list_knowledge_bases') {
        return { knowledgeBases: [{ id: 'kb-default', name: '默认知识库' }] };
      }
      if (name === 'ingest_knowledge_documents') {
        return {
          documents: [{ id: 'doc-1', status: 'queued', publicationStatus: 'draft' }],
          message: '上传成功'
        };
      }
      if (name === 'get_knowledge_document_preview') {
        return {
          document: { id: args.id, publicationStatus: 'draft' },
          preview: { excerpt: '# 文档', chunkCount: 1, headings: ['文档'] }
        };
      }
      if (name === 'publish_knowledge_document') {
        return { document: { id: args.id, publicationStatus: 'published' } };
      }
      if (name === 'withdraw_knowledge_document') {
        return { document: { id: args.id, publicationStatus: 'draft' } };
      }
      if (name === 'create_knowledge_base') {
        return { knowledgeBase: { id: 'kb-new', ...args } };
      }
      if (name === 'update_knowledge_base') {
        return { knowledgeBase: { ...args } };
      }
      return { documents: [] };
    }
  });
  const server = await listen(createApp({ knowledgeRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const bases = await fetch(`${baseUrl}/api/knowledge-bases`);
  assert.deepEqual(await bases.json(), {
    knowledgeBases: [{ id: 'kb-default', name: '默认知识库' }]
  });

  const createdBase = await fetch(`${baseUrl}/api/knowledge-bases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '项目库', description: '项目缺陷' })
  });
  assert.equal(createdBase.status, 201);
  assert.equal((await createdBase.json()).knowledgeBase.id, 'kb-new');

  const updatedBase = await fetch(`${baseUrl}/api/knowledge-bases/kb-new`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '重命名', ignored: 'must-not-pass' })
  });
  assert.deepEqual((await updatedBase.json()).knowledgeBase, {
    id: 'kb-new',
    name: '重命名'
  });

  const documents = await fetch(`${baseUrl}/api/knowledge?knowledgeBaseId=kb-new`);
  assert.deepEqual(await documents.json(), { documents: [] });

  const invalidForm = new FormData();
  invalidForm.append('files', new Blob(['binary']), 'unsafe.exe');
  const invalidUpload = await fetch(`${baseUrl}/api/knowledge/upload`, {
    method: 'POST',
    body: invalidForm
  });
  assert.equal(invalidUpload.status, 400);
  assert.match(invalidUpload.headers.get('content-type'), /application\/json/);
  assert.equal((await invalidUpload.json()).code, 'UNSUPPORTED_FILE');

  const validForm = new FormData();
  validForm.append('files', new Blob(['# 文档\n\n内容']), 'guide.md');
  const validUpload = await fetch(`${baseUrl}/api/knowledge/upload`, {
    method: 'POST',
    body: validForm
  });
  assert.equal(validUpload.status, 200);
  assert.equal((await validUpload.json()).documents[0].status, 'queued');
  const ingestCall = calls.find(({ name }) => name === 'ingest_knowledge_documents');
  assert.equal(ingestCall.args.knowledgeBaseId, 'kb-default');
  assert.deepEqual(ingestCall.args.documents, [{ name: 'guide.md', content: '# 文档\n\n内容' }]);

  const preview = await fetch(
    `${baseUrl}/api/knowledge/doc-1/preview?knowledgeBaseId=kb-new`
  );
  assert.equal((await preview.json()).preview.chunkCount, 1);
  const published = await fetch(
    `${baseUrl}/api/knowledge/doc-1/publish?knowledgeBaseId=kb-new`,
    { method: 'POST' }
  );
  assert.equal((await published.json()).document.publicationStatus, 'published');
  const withdrawn = await fetch(
    `${baseUrl}/api/knowledge/doc-1/withdraw?knowledgeBaseId=kb-new`,
    { method: 'POST' }
  );
  assert.equal((await withdrawn.json()).document.publicationStatus, 'draft');

  assert.equal((await fetch(`${baseUrl}/api/knowledge/doc-1?knowledgeBaseId=kb-new`, {
    method: 'DELETE'
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/knowledge?knowledgeBaseId=kb-new`, {
    method: 'DELETE'
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/knowledge-bases/kb-new?force=true`, {
    method: 'DELETE'
  })).status, 200);

  assert.deepEqual(
    calls.find(({ name }) => name === 'get_knowledge_document_preview').args,
    { id: 'doc-1', knowledgeBaseId: 'kb-new' }
  );
  assert.deepEqual(
    calls.find(({ name }) => name === 'publish_knowledge_document').args,
    { id: 'doc-1', knowledgeBaseId: 'kb-new' }
  );
  assert.deepEqual(
    calls.find(({ name }) => name === 'withdraw_knowledge_document').args,
    { id: 'doc-1', knowledgeBaseId: 'kb-new' }
  );
  assert.deepEqual(
    calls.find(({ name }) => name === 'delete_knowledge_document').args,
    { id: 'doc-1', knowledgeBaseId: 'kb-new' }
  );
  assert.deepEqual(
    calls.find(({ name }) => name === 'clear_knowledge_documents').args,
    { knowledgeBaseId: 'kb-new' }
  );
  assert.deepEqual(
    calls.find(({ name }) => name === 'delete_knowledge_base').args,
    { id: 'kb-new', force: true }
  );
});

test('memory routes preserve canonical contracts and leave retired Pitfall paths unavailable', async (t) => {
  const calls = [];
  const memoryRouter = createMemoryRouter({
    async callMcpTool(name, args) {
      calls.push({ name, args });
      if (name === 'list_memories') {
        return { memories: [{ id: 'memory-1' }], total: 1 };
      }
      if (name === 'update_memory') {
        return { memory: { id: args.id, title: args.title } };
      }
      return { ok: true };
    }
  });
  const server = await listen(createApp({ memoryRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const listResponse = await fetch(
    `${baseUrl}/api/memories?status=confirmed,corrected&type=fact&query=cancel&limit=99999&offset=99999999`
  );
  assert.deepEqual(await listResponse.json(), {
    memories: [{ id: 'memory-1' }],
    total: 1
  });
  assert.deepEqual(calls[0], {
    name: 'list_memories',
    args: {
      statuses: ['confirmed', 'corrected'],
      types: ['fact'],
      query: 'cancel',
      limit: 5000,
      offset: 10000000
    }
  });

  const patchResponse = await fetch(`${baseUrl}/api/memories/memory-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '更新标题', sourceConversationId: 'must-not-change' })
  });
  assert.equal(patchResponse.status, 200);
  assert.deepEqual(calls[1], {
    name: 'update_memory',
    args: { id: 'memory-1', title: '更新标题' }
  });

  assert.equal((await fetch(`${baseUrl}/api/memories/memory-1`, {
    method: 'DELETE'
  })).status, 200);

  assert.equal((await fetch(`${baseUrl}/api/pitfalls`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/pitfalls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '取消边界' })
  })).status, 404);

  assert.equal((await fetch(`${baseUrl}/api/pitfalls/pitfall-1`, {
    method: 'DELETE'
  })).status, 404);
  assert.equal(calls.some(({ name }) => name.includes('pitfall')), false);
});

test('feature routes preserve MCP business error codes and details as JSON', async (t) => {
  const knowledgeRouter = createKnowledgeRouter({
    async callMcpTool() {
      throw Object.assign(new Error('知识库仍有文档'), {
        code: 'KNOWLEDGE_BASE_NOT_EMPTY',
        details: '使用 force=true 才能删除',
        status: 409
      });
    }
  });
  const server = await listen(createApp({ knowledgeRouter }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${port}/api/knowledge-bases/kb-locked`, {
    method: 'DELETE'
  });
  assert.equal(response.status, 409);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), {
    error: '知识库仍有文档',
    code: 'KNOWLEDGE_BASE_NOT_EMPTY',
    details: '使用 force=true 才能删除'
  });
});

test('Bug knowledge routes cover project, candidate, review, and promote contracts with allowlists', async (t) => {
  const calls = [];
  const bugKnowledgeRouter = createBugKnowledgeRouter({
    async callMcpTool(name, args) {
      calls.push({ name, args });
      if (name === 'list_bug_projects') return { projects: [{ projectRef: 'project-1' }] };
      if (name === 'create_bug_project' || name === 'update_bug_project') {
        return { project: { projectRef: args.projectRef || 'project-1', ...args } };
      }
      if (name === 'list_bug_cases') return { bugCases: [{ id: 'bug-1' }] };
      if (name === 'search_bug_cases') {
        return {
          results: [{ bugCase: { id: 'bug-1' }, rank: 1, matchedChannels: ['exact'], citations: [] }],
          scope: {
            projectRefs: [args.projectRef, ...(args.additionalProjectRefs || [])],
            knowledgeBaseIds: ['kb-project-1', 'kb-common-bugs'],
            includesCommon: args.includeCommon !== false
          },
          trace: { degradedChannels: [], ambiguous: false, evidenceGap: false }
        };
      }
      if (name === 'delete_bug_case') return { ok: true, id: args.id };
      return {
        bugCase: {
          id: args.id || 'bug-1',
          reviewStatus: args.reviewStatus || 'candidate',
          ...args
        }
      };
    }
  });
  const server = await listen(createApp({ bugKnowledgeRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.deepEqual(await (await fetch(`${baseUrl}/api/bug-projects`)).json(), {
    projects: [{ projectRef: 'project-1' }]
  });
  assert.equal((await fetch(`${baseUrl}/api/bug-projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Storefront', description: 'Web', projectRef: 'forged' })
  })).status, 201);
  await fetch(`${baseUrl}/api/bug-projects/project-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Storefront Web', projectRef: 'forged', kind: 'generic' })
  });
  assert.deepEqual(calls.find(({ name }) => name === 'create_bug_project').args, {
    name: 'Storefront',
    description: 'Web'
  });
  assert.deepEqual(calls.find(({ name }) => name === 'update_bug_project').args, {
    projectRef: 'project-1',
    name: 'Storefront Web'
  });

  const listed = await fetch(
    `${baseUrl}/api/bug-cases?sourceProjectRef=project-1&scope=project&reviewStatus=candidate,confirmed&status=ready`
  );
  assert.deepEqual(await listed.json(), { bugCases: [{ id: 'bug-1' }] });
  assert.deepEqual(calls.find(({ name }) => name === 'list_bug_cases').args, {
    sourceProjectRef: 'project-1',
    scope: 'project',
    reviewStatuses: ['candidate', 'confirmed'],
    statuses: ['ready']
  });

  const content = {
    sourceProjectRef: 'project-1',
    title: 'Hydration mismatch',
    symptom: 'Mismatch',
    fix: 'Use UTC',
    reviewStatus: 'confirmed',
    reviewedBy: 'forged-admin'
  };
  const created = await fetch(`${baseUrl}/api/bug-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content)
  });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.find(({ name }) => name === 'create_bug_case').args, {
    sourceProjectRef: 'project-1',
    title: 'Hydration mismatch',
    symptom: 'Mismatch',
    fix: 'Use UTC'
  });

  const searched = await fetch(`${baseUrl}/api/bug-cases/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'Hydration mismatch',
      projectRef: 'project-1',
      includeCommon: true,
      additionalProjectRefs: ['project-2'],
      filters: { framework: 'Vue', versions: ['3.5.13'], ignored: 'drop' },
      topK: 5,
      caller: 'coding-agent'
    })
  });
  assert.equal(searched.status, 200);
  assert.equal((await searched.json()).results[0].bugCase.id, 'bug-1');
  assert.deepEqual(calls.find(({ name }) => name === 'search_bug_cases').args, {
    query: 'Hydration mismatch',
    projectRef: 'project-1',
    includeCommon: true,
    additionalProjectRefs: ['project-2'],
    filters: { framework: 'Vue', versions: ['3.5.13'] },
    topK: 5
  });

  assert.equal((await fetch(`${baseUrl}/api/bug-cases/bug-1`)).status, 200);
  await fetch(`${baseUrl}/api/bug-cases/bug-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symptom: 'Updated', sourceProjectRef: 'project-2', reviewStatus: 'confirmed' })
  });
  assert.deepEqual(calls.find(({ name }) => name === 'update_bug_case').args, {
    id: 'bug-1',
    symptom: 'Updated'
  });

  await fetch(`${baseUrl}/api/bug-cases/bug-1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewStatus: 'confirmed',
      reviewReason: '人工复现通过',
      reviewedBy: 'forged-admin'
    })
  });
  assert.deepEqual(calls.find(({ name }) => name === 'review_bug_case').args, {
    id: 'bug-1',
    reviewStatus: 'confirmed',
    reviewReason: '人工复现通过'
  });
  assert.equal((await fetch(`${baseUrl}/api/bug-cases/bug-1/promote`, {
    method: 'POST'
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/bug-cases/bug-1`, {
    method: 'DELETE'
  })).status, 200);
});
