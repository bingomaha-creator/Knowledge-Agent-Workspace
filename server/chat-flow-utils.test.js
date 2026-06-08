import assert from 'node:assert/strict';
import test from 'node:test';
import { appendToolPlanningChoice, createAutoRetrieveToolCall, getLatestUserContent, shouldAutoRetrieveKnowledge } from './chat-flow-utils.js';

test('appendToolPlanningChoice does not append non-tool draft answers before final streaming', () => {
  const messages = [{ role: 'system', content: 'system prompt' }];
  const choice = { role: 'assistant', content: '这是一段非流式草稿回答。' };

  const didAppend = appendToolPlanningChoice(messages, choice, []);

  assert.equal(didAppend, false);
  assert.equal(messages.length, 1);
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

test('shouldAutoRetrieveKnowledge requires rag enabled, documents, and a user query', () => {
  assert.equal(shouldAutoRetrieveKnowledge({ ragEnabled: true, hasKnowledge: true, query: '测试暗号是什么？' }), true);
  assert.equal(shouldAutoRetrieveKnowledge({ ragEnabled: false, hasKnowledge: true, query: '测试暗号是什么？' }), false);
  assert.equal(shouldAutoRetrieveKnowledge({ ragEnabled: true, hasKnowledge: false, query: '测试暗号是什么？' }), false);
  assert.equal(shouldAutoRetrieveKnowledge({ ragEnabled: true, hasKnowledge: true, query: '' }), false);
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
  const toolCall = createAutoRetrieveToolCall('测试暗号是什么？');

  assert.equal(toolCall.id, 'auto-retrieve-knowledge');
  assert.equal(toolCall.function.name, 'retrieve_knowledge');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    query: '测试暗号是什么？',
    topK: 4
  });
});
