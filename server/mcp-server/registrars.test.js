import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBugTools } from './register-bug-tools.js';
import { registerKnowledgeTools } from './register-knowledge-tools.js';
import { registerMemoryTools } from './register-memory-tools.js';
import { registerSystemTools } from './register-system-tools.js';

function captureRegistrations(register) {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      assert.equal(tools.has(name), false, `duplicate tool: ${name}`);
      tools.set(name, { config, handler });
    }
  };
  register(server);
  return tools;
}

test('knowledge registrar exposes governance tools and only maps DTOs to service calls', async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        calls.push({ method, args });
        if (method === 'searchKnowledge') return { citations: [{ id: 'c1' }], trace: {} };
        if (method === 'listDocuments') return [{ id: 'doc-1' }];
        return { ok: true };
      };
    }
  });
  const tools = captureRegistrations((server) =>
    registerKnowledgeTools(server, { knowledgeService: service })
  );
  assert.deepEqual([...tools.keys()].sort(), [
    'clear_knowledge_documents',
    'create_knowledge_base',
    'delete_knowledge_base',
    'delete_knowledge_document',
    'get_knowledge_document_preview',
    'ingest_knowledge_documents',
    'list_knowledge_bases',
    'list_knowledge_documents',
    'publish_knowledge_document',
    'read_knowledge_document',
    'retrieve_knowledge',
    'update_knowledge_base',
    'withdraw_knowledge_document'
  ]);

  const signal = new AbortController().signal;
  const result = await tools.get('retrieve_knowledge').handler(
    { query: 'cancel', topK: 3, knowledgeBaseIds: ['kb-a'] },
    { signal }
  );
  assert.deepEqual(calls[0], {
    method: 'searchKnowledge',
    args: ['cancel', 3, ['kb-a'], signal]
  });
  assert.deepEqual(result.structuredContent, {
    citations: [{ id: 'c1' }],
    count: 1,
    trace: {}
  });

  const readResult = await tools.get('read_knowledge_document').handler({
    documentId: 'doc-1',
    offset: 200,
    limit: 1000,
    knowledgeBaseIds: ['kb-default']
  });
  assert.deepEqual(calls[1], {
    method: 'readPublishedDocument',
    args: ['doc-1', { knowledgeBaseIds: ['kb-default'], offset: 200, limit: 1000 }]
  });
  const readSchema = tools.get('read_knowledge_document').config.inputSchema;
  assert.equal(readSchema.safeParse({ documentId: 'doc-1' }).success, true);
  assert.equal(readSchema.safeParse({ documentId: '' }).success, false);
  assert.equal(readSchema.safeParse({ documentId: 'doc-1', offset: -1 }).success, false);
  assert.equal(readSchema.safeParse({ documentId: 'doc-1', limit: 0 }).success, false);
  assert.equal(readSchema.safeParse({ documentId: 'doc-1', limit: 12_001 }).success, false);

  await tools.get('get_knowledge_document_preview').handler({
    id: 'doc-1',
    knowledgeBaseId: 'kb-a'
  });
  await tools.get('publish_knowledge_document').handler({ id: 'doc-1', knowledgeBaseId: 'kb-a' });
  await tools.get('withdraw_knowledge_document').handler({ id: 'doc-1', knowledgeBaseId: 'kb-a' });
  assert.deepEqual(calls.slice(2).map(({ method, args }) => ({ method, args })), [
    { method: 'getDocumentPreview', args: ['doc-1', 'kb-a'] },
    { method: 'publishDocument', args: ['doc-1', 'kb-a'] },
    { method: 'withdrawDocument', args: ['doc-1', 'kb-a'] }
  ]);
});

test('memory registrar exposes only canonical tools and maps business failures to MCP errors', async () => {
  const calls = [];
  const service = {
    async searchMemories() { return []; },
    async createMemory(input) {
      calls.push(input);
      return { memory: { ...input, id: 'memory-1', status: 'confirmed' }, duplicate: false };
    },
    async proposeMemory() {
      throw Object.assign(new Error('blocked'), {
        code: 'SENSITIVE_MEMORY',
        details: 'secret',
        status: 400
      });
    },
    listMemories() { return []; },
    countMemories() { return 0; },
    async updateMemory() { return {}; },
    deleteMemory() { return { ok: true }; }
  };
  const tools = captureRegistrations((server) =>
    registerMemoryTools(server, { memoryService: service })
  );
  assert.deepEqual([...tools.keys()].sort(), [
    'create_memory',
    'delete_memory',
    'list_memories',
    'propose_memory',
    'retrieve_memory',
    'update_memory'
  ]);

  const created = await tools.get('create_memory').handler({
    type: 'preference',
    title: '回答风格',
    content: '回答时先给结论，再解释原因。'
  });
  assert.equal(created.structuredContent.memory.status, 'confirmed');
  assert.deepEqual(calls, [{
    type: 'preference',
    title: '回答风格',
    content: '回答时先给结论，再解释原因。'
  }]);

  const result = await tools.get('propose_memory').handler({
    type: 'fact',
    title: 'secret',
    content: 'secret'
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: 'SENSITIVE_MEMORY',
    message: 'blocked',
    details: 'secret',
    status: 400
  });
});

test('system registrar keeps current-time and bounded web-search tool DTOs', async () => {
  const tools = captureRegistrations((server) => registerSystemTools(server, {
    webSearchProvider: {
      async search(query, options) {
        return { query, topK: options.topK, status: 'success', results: [] };
      }
    },
    now: () => new Date('2026-07-16T08:00:00.000Z')
  }));
  assert.deepEqual([...tools.keys()].sort(), ['get_current_time', 'search_web']);
  assert.deepEqual(
    (await tools.get('get_current_time').handler({})).structuredContent.iso,
    '2026-07-16T08:00:00.000Z'
  );
  assert.deepEqual(
    (await tools.get('search_web').handler({ query: 'MCP', topK: 2 })).structuredContent,
    { query: 'MCP', topK: 2, status: 'success', results: [] }
  );
});

test('Bug registrar exposes explicit project, CRUD, review, and promote DTO adapters', async () => {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, method) {
      return (...args) => {
        calls.push({ method, args });
        if (method === 'listProjects') return [{ projectRef: 'project-1' }];
        if (method === 'listBugCases') return [{ id: 'bug-1' }];
        return { id: 'bug-1', ok: true };
      };
    }
  });
  const tools = captureRegistrations((server) =>
    registerBugTools(server, { bugKnowledgeService: service })
  );
  assert.deepEqual([...tools.keys()].sort(), [
    'create_bug_case',
    'create_bug_project',
    'delete_bug_case',
    'get_bug_case',
    'list_bug_cases',
    'list_bug_projects',
    'promote_bug_case',
    'review_bug_case',
    'search_bug_cases',
    'update_bug_case',
    'update_bug_project'
  ]);
  assert.doesNotThrow(() => tools.get('create_bug_case').config.inputSchema.parse({
    sourceProjectRef: 'project-1',
    title: 'Verified workaround',
    symptom: 'Intermittent failure',
    resolutionType: 'verified_workaround',
    rootCause: null,
    fix: 'Bounded workaround'
  }));

  const reviewed = await tools.get('review_bug_case').handler({
    id: 'bug-1',
    reviewStatus: 'confirmed',
    reviewReason: '人工复现通过'
  });
  assert.deepEqual(calls.at(-1), {
    method: 'reviewBugCase',
    args: ['bug-1', { reviewStatus: 'confirmed', reviewReason: '人工复现通过' }]
  });
  assert.equal(reviewed.structuredContent.bugCase.id, 'bug-1');

  const signal = new AbortController().signal;
  await tools.get('search_bug_cases').handler({
    query: 'TypeError',
    projectRef: 'project-1',
    includeCommon: true,
    additionalProjectRefs: [],
    topK: 5
  }, { signal });
  assert.deepEqual(calls.at(-1), {
    method: 'searchBugCases',
    args: [{
      query: 'TypeError',
      projectRef: 'project-1',
      includeCommon: true,
      additionalProjectRefs: [],
      topK: 5
    }, signal]
  });
});
