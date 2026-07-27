import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTrustedToolArguments,
  createToolExecutor,
  evaluateToolCall,
  filterTools,
  getToolSpec,
  listToolSpecs
} from './tool-capabilities.js';
import { registerKnowledgeTools } from './mcp/register-knowledge-tools.js';
import { registerBugTools } from './mcp/register-bug-tools.js';
import { registerMemoryTools } from './mcp/register-memory-tools.js';
import { registerSystemTools } from './mcp/register-system-tools.js';

const EXPECTED_TOOL_NAMES = [
  'retrieve_knowledge',
  'list_knowledge_documents',
  'ingest_knowledge_documents',
  'get_knowledge_document_preview',
  'publish_knowledge_document',
  'withdraw_knowledge_document',
  'delete_knowledge_document',
  'clear_knowledge_documents',
  'list_knowledge_bases',
  'create_knowledge_base',
  'update_knowledge_base',
  'delete_knowledge_base',
  'retrieve_memory',
  'create_memory',
  'propose_memory',
  'list_memories',
  'update_memory',
  'delete_memory',
  'get_current_time',
  'search_web',
  'list_bug_projects',
  'create_bug_project',
  'update_bug_project',
  'list_bug_cases',
  'create_bug_case',
  'get_bug_case',
  'update_bug_case',
  'delete_bug_case',
  'review_bug_case',
  'promote_bug_case',
  'search_bug_cases'
];

function captureRegistrarNames() {
  const names = [];
  const server = { registerTool(name) { names.push(name); } };
  registerKnowledgeTools(server, { knowledgeService: {} });
  registerMemoryTools(server, { memoryService: {} });
  registerSystemTools(server, { webSearchProvider: {} });
  registerBugTools(server, { bugKnowledgeService: {} });
  return names;
}

test('ToolSpec registry exactly covers every registered MCP tool', () => {
  const specs = listToolSpecs();
  assert.equal(new Set(specs.map((spec) => spec.name)).size, specs.length);
  assert.deepEqual(
    specs.map((spec) => spec.name).sort(),
    [...EXPECTED_TOOL_NAMES].sort()
  );
  assert.deepEqual(
    captureRegistrarNames().sort(),
    [...EXPECTED_TOOL_NAMES].sort()
  );
  for (const spec of specs) {
    assert.ok(spec.description);
    assert.ok(spec.effects.length > 0);
    assert.ok(spec.allowedCallers.length > 0);
  }
});

test('unknown, write, and network tools default deny autonomous chat', () => {
  const context = { caller: 'chat', invocation: 'autonomous' };
  assert.equal(evaluateToolCall('unknown_tool', context).allowed, false);
  assert.equal(evaluateToolCall('unknown_tool', {
    caller: 'internal',
    invocation: 'explicit'
  }).allowed, false);
  assert.equal(evaluateToolCall('update_memory', context).allowed, false);
  assert.equal(evaluateToolCall('search_web', context).allowed, false);
  assert.equal(evaluateToolCall('retrieve_knowledge', context).allowed, true);
});

test('chat visibility, preset intersection, and disabled knowledge scope share ToolSpec policy', () => {
  const discovered = EXPECTED_TOOL_NAMES.map((name) => ({ name }));
  assert.deepEqual(
    filterTools(discovered, {
      caller: 'chat',
      invocation: 'autonomous',
      knowledgeScopeEnabled: true
    }).map((tool) => tool.name),
    ['retrieve_knowledge', 'list_knowledge_documents', 'get_current_time']
  );
  assert.deepEqual(
    filterTools(discovered, {
      caller: 'chat',
      invocation: 'autonomous',
      knowledgeScopeEnabled: false
    }).map((tool) => tool.name),
    ['get_current_time']
  );
  assert.deepEqual(
    filterTools(discovered, {
      caller: 'chat',
      invocation: 'autonomous',
      allowedToolNames: new Set(['list_knowledge_documents', 'update_memory'])
    }).map((tool) => tool.name),
    ['list_knowledge_documents']
  );
});

test('internal memory orchestration and research web search use distinct trusted callers', () => {
  assert.equal(evaluateToolCall('create_memory', {
    caller: 'internal',
    invocation: 'explicit'
  }).allowed, true);
  assert.equal(evaluateToolCall('create_memory', {
    caller: 'internal',
    invocation: 'orchestrated'
  }).allowed, false);
  assert.equal(evaluateToolCall('propose_memory', {
    caller: 'internal',
    invocation: 'orchestrated'
  }).allowed, true);
  assert.equal(evaluateToolCall('propose_memory', {
    caller: 'chat',
    invocation: 'autonomous'
  }).allowed, false);
  assert.equal(evaluateToolCall('search_web', {
    caller: 'research',
    invocation: 'orchestrated'
  }).allowed, true);
  assert.equal(evaluateToolCall('search_web', {
    caller: 'internal',
    invocation: 'orchestrated'
  }).allowed, false);
  assert.equal(evaluateToolCall('update_memory', {
    caller: 'internal',
    invocation: 'orchestrated'
  }).allowed, false);
  assert.equal(evaluateToolCall('update_memory', {
    caller: 'internal',
    invocation: 'explicit'
  }).allowed, true);
});

test('Research can orchestrate confirmed knowledge reads without gaining knowledge writes', () => {
  assert.equal(evaluateToolCall('retrieve_knowledge', {
    caller: 'research',
    invocation: 'orchestrated'
  }).allowed, true);
  assert.equal(evaluateToolCall('ingest_knowledge_documents', {
    caller: 'research',
    invocation: 'explicit'
  }).allowed, false);
  assert.equal(evaluateToolCall('delete_knowledge_document', {
    caller: 'research',
    invocation: 'explicit'
  }).allowed, false);
  for (const name of [
    'get_knowledge_document_preview',
    'publish_knowledge_document',
    'withdraw_knowledge_document'
  ]) {
    assert.equal(evaluateToolCall(name, {
      caller: 'research',
      invocation: 'explicit'
    }).allowed, false, name);
    assert.equal(evaluateToolCall(name, {
      caller: 'internal',
      invocation: 'explicit'
    }).allowed, true, name);
  }
});

test('Bug tools require a trusted explicit bug-ui or internal caller', () => {
  for (const name of EXPECTED_TOOL_NAMES.filter((toolName) => toolName.includes('_bug_'))) {
    assert.equal(evaluateToolCall(name, {
      caller: 'bug-ui',
      invocation: 'explicit'
    }).allowed, true, name);
    assert.equal(evaluateToolCall(name, {
      caller: 'chat',
      invocation: 'autonomous'
    }).allowed, false, name);
    assert.equal(evaluateToolCall(name, {
      caller: 'bug-ui',
      invocation: 'orchestrated'
    }).allowed, false, name);
  }
});

test('Bug search reserves coding-agent caller without exposing it to chat or internal routes', () => {
  assert.deepEqual(getToolSpec('search_bug_cases').allowedCallers, ['bug-ui', 'coding-agent']);
  assert.equal(evaluateToolCall('search_bug_cases', {
    caller: 'coding-agent',
    invocation: 'explicit'
  }).allowed, true);
  assert.equal(evaluateToolCall('search_bug_cases', {
    caller: 'internal',
    invocation: 'explicit'
  }).allowed, false);
  assert.equal(evaluateToolCall('search_bug_cases', {
    caller: 'chat',
    invocation: 'autonomous'
  }).allowed, false);
});

test('trusted knowledge scope replaces model arguments and preserves an explicit empty scope', () => {
  assert.deepEqual(
    applyTrustedToolArguments(
      'retrieve_knowledge',
      { query: 'test', knowledgeBaseIds: ['kb-invented'] },
      { knowledgeBaseIds: ['kb-trusted'] }
    ),
    { query: 'test', knowledgeBaseIds: ['kb-trusted'] }
  );
  assert.deepEqual(
    applyTrustedToolArguments(
      'list_knowledge_documents',
      { knowledgeBaseIds: ['kb-invented'] },
      { knowledgeBaseIds: [] }
    ),
    { knowledgeBaseIds: [] }
  );
});

test('tool executor rejects forged caller arguments before invoking the gateway', async () => {
  const calls = [];
  const executor = createToolExecutor({
    gateway: {
      async callTool(name, args, options) {
        calls.push({ name, args, options });
        return { structured: { ok: true }, isError: false, text: '' };
      }
    }
  });

  await assert.rejects(
    executor.callTool(
      'search_web',
      { query: 'test', caller: 'research' },
      { caller: 'chat', invocation: 'autonomous' }
    ),
    (error) => error.code === 'TOOL_NOT_ALLOWED' && error.status === 403
  );
  assert.equal(calls.length, 0);

  await executor.callTool(
    'retrieve_knowledge',
    { query: 'test', knowledgeBaseIds: ['kb-invented'] },
    {
      caller: 'chat',
      invocation: 'autonomous',
      knowledgeBaseIds: ['kb-trusted']
    },
    { signal: new AbortController().signal }
  );
  assert.deepEqual(calls[0].args, {
    query: 'test',
    knowledgeBaseIds: ['kb-trusted']
  });
});

test('registrar descriptions equal the single ToolSpec descriptions', () => {
  const registrations = [];
  const server = {
    registerTool(name, config) {
      registrations.push({ name, description: config.description });
    }
  };
  registerKnowledgeTools(server, { knowledgeService: {} });
  registerMemoryTools(server, { memoryService: {} });
  registerSystemTools(server, { webSearchProvider: {} });
  registerBugTools(server, { bugKnowledgeService: {} });
  for (const registration of registrations) {
    assert.equal(
      registration.description,
      getToolSpec(registration.name).description
    );
  }
});
