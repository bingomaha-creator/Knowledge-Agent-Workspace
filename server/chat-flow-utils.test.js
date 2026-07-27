import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendToolPlanningChoice,
  createAutoRetrieveToolCall,
  getLatestUserContent,
  getModelVisibleTools,
  getPresetVisibleTools,
  isToolExecutionAllowed,
  mergeCitations
} from './chat-flow-utils.js';

test('appendToolPlanningChoice does not append non-tool draft answers before final streaming', () => {
  const messages = [{ role: 'system', content: 'system prompt' }];
  const choice = { role: 'assistant', content: '这是一段非流式草稿回答。' };

  const didAppend = appendToolPlanningChoice(messages, choice, []);

  assert.equal(didAppend, false);
  assert.equal(messages.length, 1);
});

test('mergeCitations deduplicates chunks and keeps the stronger result', () => {
  const merged = mergeCitations(
    [{ id: 'chunk-1', title: 'A', score: 0.01 }],
    [
      { id: 'chunk-1', title: 'A newer', score: 0.03 },
      { id: 'chunk-2', title: 'B', score: 0.02 }
    ]
  );

  assert.deepEqual(merged, [
    { id: 'chunk-1', title: 'A newer', score: 0.03 },
    { id: 'chunk-2', title: 'B', score: 0.02 }
  ]);
});

test('appendToolPlanningChoice appends assistant tool calls for tool execution rounds', () => {
  const messages = [{ role: 'system', content: 'system prompt' }];
  const toolCalls = [
    {
      id: 'call-1',
      type: 'function',
      function: {
        name: 'retrieve_knowledge',
        arguments: '{"query":"项目阅读路线"}'
      }
    }
  ];
  const choice = { role: 'assistant', content: '', tool_calls: toolCalls };

  const didAppend = appendToolPlanningChoice(messages, choice, toolCalls);

  assert.equal(didAppend, true);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls
  });
});

test('getLatestUserContent returns the newest user message', () => {
  const messages = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '测试暗号是什么？' }
  ];

  assert.equal(getLatestUserContent(messages), '测试暗号是什么？');
});

test('createAutoRetrieveToolCall builds a retrieve_knowledge call for the latest query', () => {
  const toolCall = createAutoRetrieveToolCall('测试暗号是什么？', ['kb-project']);

  assert.equal(toolCall.id, 'auto-retrieve-knowledge');
  assert.equal(toolCall.function.name, 'retrieve_knowledge');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    query: '测试暗号是什么？',
    topK: 4,
    knowledgeBaseIds: ['kb-project']
  });
});

test('createAutoRetrieveToolCall keeps the legacy payload without a scope', () => {
  const toolCall = createAutoRetrieveToolCall('测试暗号是什么？');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    query: '测试暗号是什么？',
    topK: 4
  });
});

test('createAutoRetrieveToolCall does not invent a fallback for an empty knowledge scope', () => {
  const toolCall = createAutoRetrieveToolCall('不要检索任何知识库', []);

  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    query: '不要检索任何知识库',
    topK: 4
  });
});

test('getModelVisibleTools exposes only safe read-only tools to autonomous planning', () => {
  const tools = [
    { name: 'retrieve_knowledge' },
    { name: 'list_knowledge_documents' },
    { name: 'get_current_time' },
    { name: 'ingest_knowledge_documents' },
    { name: 'delete_knowledge_document' },
    { name: 'clear_knowledge_documents' },
    { name: 'propose_memory' },
    { name: 'retrieve_memory' },
    { name: 'delete_memory' }
  ];

  assert.deepEqual(getModelVisibleTools(tools).map((tool) => tool.name), [
    'retrieve_knowledge',
    'list_knowledge_documents',
    'get_current_time'
  ]);

  assert.deepEqual(
    getModelVisibleTools(tools, { ragEnabled: false }).map((tool) => tool.name),
    ['get_current_time']
  );
});

test('preset filtering keeps list-only knowledge access without enabling retrieval', () => {
  const tools = [
    { name: 'retrieve_knowledge' },
    { name: 'list_knowledge_documents' },
    { name: 'get_current_time' }
  ];
  assert.deepEqual(
    getPresetVisibleTools(tools, {
      knowledgeScopeEnabled: true,
      toolWhitelist: ['list_knowledge_documents']
    }).map((tool) => tool.name),
    ['list_knowledge_documents']
  );
  assert.deepEqual(
    getPresetVisibleTools(tools, {
      knowledgeScopeEnabled: false,
      toolWhitelist: ['list_knowledge_documents', 'get_current_time']
    }).map((tool) => tool.name),
    ['get_current_time']
  );
});

test('runtime tool guard blocks hidden write tools even if a model invents the call', () => {
  const allowed = new Set(['retrieve_knowledge', 'get_current_time']);
  assert.equal(isToolExecutionAllowed('retrieve_knowledge', allowed), true);
  assert.equal(isToolExecutionAllowed('update_memory', allowed), false);
  assert.equal(isToolExecutionAllowed('delete_memory', allowed), false);
  assert.equal(isToolExecutionAllowed('update_memory'), false, 'missing allow-set cannot bypass policy');
  assert.equal(isToolExecutionAllowed('unknown_tool'), false);
});
