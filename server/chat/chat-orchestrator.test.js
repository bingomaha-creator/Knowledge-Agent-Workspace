import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPresets } from '../preset-utils.js';
import { createRunStore } from '../run-store.js';
import { createToolExecutor } from '../tool-capabilities.js';
import { createChatOrchestrator } from './chat-orchestrator.js';

function createFixture(t, streamBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-orchestrator-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const modelCalls = [];
  const toolCalls = [];
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(body, options) {
        modelCalls.push({ body, options });
        if (!options.stream) {
          return {
            choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 }
          };
        }
        return new Response(streamBody, {
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() {
        return { tools: [{ name: 'get_current_time', description: '获取当前系统时间' }] };
      }
    },
    toolExecutor: {
      async callTool(name, args, context, options) {
        toolCalls.push({ name, args, context, options });
        if (name === 'retrieve_memory') {
          return { structured: { memories: [] }, text: '', isError: false };
        }
        throw new Error(`unexpected tool ${name}`);
      },
      async callToolOrThrow(name) {
        throw new Error(`unexpected required tool ${name}`);
      }
    },
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    candidateTimeoutMs: 50,
    sleep: async () => {}
  });
  return { orchestrator, runStore, modelCalls, toolCalls };
}

test('orchestrator emits the existing run/token/done protocol and keeps usage inside run snapshots', async (t) => {
  const fixture = createFixture(t, [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n'));
  const events = [];
  const result = await fixture.orchestrator.run({
    conversationId: 'conversation-success',
    messages: [{ role: 'user', content: '你好' }],
    ragEnabled: false,
    knowledgeBaseIds: []
  }, {
    signal: new AbortController().signal,
    emit(event) { events.push(event); }
  });

  assert.equal(result.status, 'success');
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(events.some((event) => event.type === 'usage'), false);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(
    events.filter((event) => event.type === 'token').map((event) => event.data.token).join(''),
    '你好'
  );
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.inputTokens, 5);
  assert.equal(result.run.outputTokens, 3);
  assert.ok(result.run.spans.every((span) => span.status !== 'running'));
  assert.equal(fixture.toolCalls[0].name, 'retrieve_memory');
  assert.equal(fixture.toolCalls[0].args.topK, 3);
  assert.deepEqual(fixture.toolCalls[0].context, {
    caller: 'internal',
    invocation: 'orchestrated'
  });
});

test('orchestrator rebuilds governed context for planning and generation without the old 12-message product limit', async (t) => {
  const fixture = createFixture(t, [
    'data: {"choices":[{"delta":{"content":"完成"}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n'));
  const messages = Array.from({ length: 15 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史消息 ${index + 1}`
  }));

  const result = await fixture.orchestrator.run({
    conversationId: 'conversation-context-governance',
    messages,
    ragEnabled: false,
    knowledgeBaseIds: []
  }, {
    signal: new AbortController().signal,
    emit() {}
  });

  assert.equal(result.status, 'success');
  assert.equal(fixture.modelCalls.length, 2);
  for (const call of fixture.modelCalls) {
    const originalContents = call.body.messages
      .map((message) => message.content)
      .filter((content) => /^历史消息 \d+$/.test(content));
    assert.equal(originalContents.length, 15);
    assert.equal(call.body.messages.some((message) => 'id' in message), false);
  }

  const planning = result.run.spans.find((span) => span.name === 'tool_planning');
  const generation = result.run.spans.find((span) => span.name === 'generation');
  assert.equal(planning.metadata.contextManifest.purpose, 'tool_planning');
  assert.equal(generation.metadata.contextManifest.purpose, 'answer_generation');
  assert.equal(
    result.run.metadata.contextSummary.buildId,
    generation.metadata.contextManifest.buildId
  );
});

test('usage followed by EOF remains an error and leaves no running run/span', async (t) => {
  const fixture = createFixture(t, [
    'data: {"choices":[{"delta":{"content":"partial"}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
    ''
  ].join('\n'));
  const events = [];
  const result = await fixture.orchestrator.run({
    conversationId: 'conversation-incomplete',
    messages: [{ role: 'user', content: '你好' }],
    ragEnabled: false,
    knowledgeBaseIds: []
  }, {
    signal: new AbortController().signal,
    emit(event) { events.push(event); }
  });

  assert.equal(result.status, 'error');
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.some((event) => event.type === 'done'), false);
  assert.equal(events.at(-1).data.code, 'UPSTREAM_STREAM_INCOMPLETE');
  assert.equal(result.run.status, 'error');
  const generation = result.run.spans.find((span) => span.name === 'generation');
  assert.equal(generation.status, 'error');
  assert.equal(generation.inputTokens, 7);
  assert.equal(generation.outputTokens, 4);
  assert.ok(result.run.spans.every((span) => span.status !== 'running'));
});

test('invented hidden tools are rejected before Gateway and the model can continue to a final answer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-hidden-tool-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gatewayCalls = [];
  const planningBodies = [];
  let planningRound = 0;
  const gateway = {
    async callTool(name) {
      gatewayCalls.push(name);
      if (name === 'retrieve_memory') {
        return { structured: { memories: [] }, text: '', isError: false };
      }
      throw new Error(`Gateway must not receive ${name}`);
    },
    async callToolOrThrow(name, args, options) {
      return this.callTool(name, args, options);
    }
  };
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(body, { stream }) {
        if (stream) return new Response('data: {"choices":[{"delta":{"content":"安全回答"}}]}\n\ndata: [DONE]\n\n');
        planningBodies.push(body);
        planningRound += 1;
        return planningRound === 1
          ? {
              choices: [{ message: {
                content: '',
                tool_calls: [{
                  id: 'call-hidden',
                  type: 'function',
                  function: {
                    name: 'update_memory',
                    arguments: '{"id":"memory-1","caller":"internal"}'
                  }
                }]
              } }],
              usage: {}
            }
          : { choices: [{ message: { content: '', tool_calls: [] } }], usage: {} };
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() {
        return {
          tools: [
            { name: 'get_current_time' },
            { name: 'update_memory' }
          ]
        };
      }
    },
    toolExecutor: createToolExecutor({ gateway }),
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    sleep: async () => {}
  });
  const events = [];
  const result = await orchestrator.run({
    conversationId: 'conversation-hidden',
    messages: [{ role: 'user', content: '请回答问题' }],
    ragEnabled: false,
    knowledgeBaseIds: []
  }, {
    signal: new AbortController().signal,
    emit(event) { events.push(event); }
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(gatewayCalls, ['retrieve_memory']);
  const hiddenTerminal = events.find(
    (event) => event.type === 'tool' && event.data.id === 'call-hidden' && event.data.status === 'error'
  );
  assert.equal(hiddenTerminal.data.result.code, 'TOOL_NOT_ALLOWED');
  const toolMessage = planningBodies[1].messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call-hidden'
  );
  assert.equal(JSON.parse(toolMessage.content).code, 'TOOL_NOT_ALLOWED');
  assert.equal(events.at(-1).type, 'done');
});

test('an allowed MCP business error is returned to the model instead of terminating chat', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-tool-error-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gatewayCalls = [];
  const planningBodies = [];
  let planningRound = 0;
  const gateway = {
    async callTool(name) {
      gatewayCalls.push(name);
      if (name === 'retrieve_memory') {
        return { structured: { memories: [] }, text: '', isError: false };
      }
      return {
        structured: {
          code: 'CLOCK_UNAVAILABLE',
          message: '时钟暂不可用',
          details: ''
        },
        text: '时钟暂不可用',
        isError: true
      };
    },
    async callToolOrThrow(name, args, options) {
      return this.callTool(name, args, options);
    }
  };
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(body, { stream }) {
        if (stream) return new Response('data: {"choices":[{"delta":{"content":"继续回答"}}]}\n\ndata: [DONE]\n\n');
        planningBodies.push(body);
        planningRound += 1;
        return planningRound === 1
          ? { choices: [{ message: { content: '', tool_calls: [{
              id: 'call-clock',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' }
            }] } }], usage: {} }
          : { choices: [{ message: { content: '', tool_calls: [] } }], usage: {} };
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() { return { tools: [{ name: 'get_current_time' }] }; }
    },
    toolExecutor: createToolExecutor({ gateway }),
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    sleep: async () => {}
  });
  const events = [];
  const result = await orchestrator.run({
    conversationId: 'conversation-business-error',
    messages: [{ role: 'user', content: '现在几点？' }],
    ragEnabled: false,
    knowledgeBaseIds: []
  }, {
    signal: new AbortController().signal,
    emit(event) { events.push(event); }
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(gatewayCalls, ['retrieve_memory', 'get_current_time']);
  assert.equal(
    JSON.parse(planningBodies[1].messages.find((message) => message.role === 'tool').content).code,
    'CLOCK_UNAVAILABLE'
  );
  assert.equal(events.some(
    (event) => event.type === 'tool' && event.data.status === 'error'
  ), true);
  assert.equal(events.at(-1).type, 'done');
});

test('missing knowledge scope uses preset defaults while an explicit empty scope stays empty', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-scope-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scopeChecks = [];
  const toolExecutor = {
    async callTool(name) {
      if (name === 'retrieve_memory') {
        return { structured: { memories: [] }, text: '', isError: false };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    async callToolOrThrow(name, args) {
      scopeChecks.push({ name, args });
      return { structured: { documents: [] }, text: '', isError: false };
    }
  };
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(_body, { stream }) {
        return stream
          ? new Response('data: [DONE]\n\n')
          : { choices: [{ message: { content: '', tool_calls: [] } }], usage: {} };
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() {
        return { tools: [{ name: 'retrieve_knowledge' }, { name: 'get_current_time' }] };
      }
    },
    toolExecutor,
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    sleep: async () => {}
  });
  const run = (request) => orchestrator.run({
    conversationId: crypto.randomUUID(),
    messages: [{ role: 'user', content: '普通问题' }],
    ...request
  }, {
    signal: new AbortController().signal,
    emit() {}
  });

  await run({});
  await run({ knowledgeBaseIds: [] });
  assert.deepEqual(scopeChecks, [{
    name: 'list_knowledge_documents',
    args: { knowledgeBaseIds: ['kb-default'], statuses: ['ready'] }
  }]);
});

test('scoped retrieval records an evidence gap instead of injecting an empty tool exchange', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-empty-auto-rag-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const modelBodies = [];
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(body, { stream }) {
        modelBodies.push(body);
        assert.equal(stream, true);
        return new Response('data: {"choices":[{"delta":{"content":"资料未覆盖"}}]}\n\ndata: [DONE]\n\n');
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() {
        return { tools: [{ name: 'retrieve_knowledge' }] };
      }
    },
    toolExecutor: {
      async callTool(name) {
        if (name === 'retrieve_memory') {
          return { structured: { memories: [] }, text: '', isError: false };
        }
        if (name === 'retrieve_knowledge') {
          return {
            structured: { citations: [] },
            text: '没有命中相关内容',
            isError: false
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
      async callToolOrThrow(name) {
        assert.equal(name, 'list_knowledge_documents');
        return {
          structured: { documents: [{ id: 'doc-ready' }] },
          text: '',
          isError: false
        };
      }
    },
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    sleep: async () => {}
  });

  const result = await orchestrator.run({
    conversationId: 'conversation-empty-auto-rag',
    messages: [{ id: 'user-1', role: 'user', content: '请根据知识库文档回答这个问题' }],
    ragEnabled: true,
    knowledgeBaseIds: ['kb-default']
  }, {
    signal: new AbortController().signal,
    emit() {}
  });

  const generation = result.run.spans.find((span) => span.name === 'generation');
  assert.equal(generation.metadata.contextManifest.summary.includedByKind.knowledge_chunk, undefined);
  assert.equal(generation.metadata.contextManifest.summary.includedByKind.tool_exchange, undefined);
  const evidenceGate = result.run.spans.find((span) => span.name === 'knowledge_evidence_gate');
  assert.deepEqual(evidenceGate.metadata.evidence, {
    policyVersion: 'chat-evidence-v3',
    status: 'evidence_gap',
    reason: 'no_candidates',
    candidateCount: 0,
    selectedCount: 0,
    filteredCount: 0,
    channels: {
      keywordCandidates: 0,
      querySpecificKeywordCandidates: 0,
      vectorOnlyCandidates: 0,
      degradedChannels: []
    }
  });
  assert.equal(modelBodies[0].messages.some((message) => message.role === 'tool'), false);
});

test('a scoped project fact is retrieved before generation even without knowledge-related wording', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-forced-rag-'));
  const runStore = createRunStore(path.join(root, 'runs.sqlite'));
  t.after(() => {
    runStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const toolCalls = [];
  const modelBodies = [];
  const orchestrator = createChatOrchestrator({
    qwenClient: {
      async chatCompletions(body, { stream }) {
        modelBodies.push({ body, stream });
        assert.equal(stream, true, 'only the final generation should run when retrieve is the sole tool');
        return new Response('data: {"choices":[{"delta":{"content":"蓝色星河"}}]}\n\ndata: [DONE]\n\n');
      }
    },
    mcpGateway: {
      async connect() {},
      async listTools() { return { tools: [{ name: 'retrieve_knowledge' }] }; }
    },
    toolExecutor: {
      async callTool(name, args) {
        toolCalls.push({ name, args });
        if (name === 'retrieve_memory') return { structured: { memories: [] }, text: '', isError: false };
        if (name === 'retrieve_knowledge') {
          return {
            structured: {
              citations: [{
                id: 'chunk-passphrase',
                title: 'test-knowledge.md',
                snippet: '测试暗号是：蓝色星河。',
                source: 'test-knowledge.md',
                retrieval: { sources: ['vector', 'keyword'] }
              }],
              trace: { degradedChannels: [] }
            },
            text: '',
            isError: false
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
      async callToolOrThrow() {
        return { structured: { documents: [{ id: 'doc-ready' }] }, text: '', isError: false };
      }
    },
    runStore,
    presets: loadPresets(''),
    model: 'qwen-test',
    pricing: {},
    modelRetries: 0,
    sleep: async () => {}
  });

  const result = await orchestrator.run({
    conversationId: 'conversation-project-fact',
    messages: [{ id: 'user-1', role: 'user', content: '项目暗号是什么？' }],
    ragEnabled: true,
    knowledgeBaseIds: ['kb-default']
  }, { signal: new AbortController().signal, emit() {} });

  assert.deepEqual(toolCalls.map((call) => call.name), ['retrieve_memory', 'retrieve_knowledge']);
  assert.deepEqual(toolCalls[1].args, {
    query: '项目暗号是什么？',
    topK: 4,
    knowledgeBaseIds: ['kb-default']
  });
  const generation = result.run.spans.find((span) => span.name === 'generation');
  assert.equal(generation.metadata.contextManifest.summary.includedByKind.knowledge_chunk, 1);
  const evidenceGate = result.run.spans.find((span) => span.name === 'knowledge_evidence_gate');
  assert.equal(evidenceGate.metadata.evidence.status, 'evidence');
  assert.equal(evidenceGate.metadata.evidence.reason, 'hybrid_match');
  assert.equal(modelBodies.length, 1);
});
