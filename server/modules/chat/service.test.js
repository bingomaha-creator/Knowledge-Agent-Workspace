import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChatStore } from './store.js';
import { createChatService } from './service.js';

function temporaryDatabasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-service-'));
  return path.join(directory, 'chat.sqlite');
}

function createFixture(run, options = {}) {
  let id = 0;
  let timestamp = 2_000;
  const store = createChatStore(temporaryDatabasePath(), {
    createId(prefix) {
      id += 1;
      return `${prefix}-${id}`;
    },
    now() {
      timestamp += 1;
      return timestamp;
    }
  });
  const service = createChatService({
    store,
    orchestrator: { run },
    listMemories: options.listMemories,
    checkpointIntervalMs: options.checkpointIntervalMs ?? 0
  });
  return { service, store };
}

function input(overrides = {}) {
  return {
    requestId: 'request-1',
    content: '第一轮问题',
    presetId: 'documents',
    ragEnabled: true,
    knowledgeBaseIds: ['kb-project'],
    ...overrides
  };
}

test('restart recovery batches canonical Memory and removes deleted historical projections', async (t) => {
  const dbPath = temporaryDatabasePath();
  let store = createChatStore(dbPath);
  const messages = [];
  for (let index = 0; index < 101; index += 1) {
    const started = store.startTurn(input({ requestId: `recovery-${index}` }));
    messages.push(started.assistantMessage.id);
    store.updateAssistantMessage(started.assistantMessage.id, {
      status: 'done', memoryCandidate: { id: `memory-${index}`, title: '旧候选', status: 'candidate' }
    });
  }
  store.close();
  store = createChatStore(dbPath);
  t.after(() => store.close());
  const batches = [];
  const service = createChatService({
    store, orchestrator: { run: async () => {} },
    listMemories: async (filters) => {
      batches.push(filters);
      return filters.ids.filter((id) => id !== 'memory-0').map((id) => ({
        id, title: '规范记录', content: '已人工纠正', status: 'corrected'
      }));
    }
  });
  await service.recoverMemoryProjections();
  assert.deepEqual(batches.map((batch) => batch.ids.length), [100, 1]);
  assert.ok(batches.every((batch) => batch.limit === 100 && batch.offset === 0 && !('statuses' in batch)));
  assert.equal(store.getMessage(messages[0]).memoryCandidate, null);
  assert.equal(store.getMessage(messages[1]).memoryCandidate.status, 'corrected');
  await service.recoverMemoryProjections();
  assert.equal(store.getMessage(messages[1]).memoryCandidate.content, '已人工纠正');
});

test('failed or malformed canonical lookup never erases historical Memory projections', async (t) => {
  let result;
  const { service, store } = createFixture(async () => {}, {
    listMemories: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  });
  t.after(() => store.close());
  const started = store.startTurn(input());
  const candidate = { id: 'memory-1', title: '保留候选', status: 'candidate' };
  store.updateAssistantMessage(started.assistantMessage.id, { status: 'done', memoryCandidate: candidate });
  for (result of [new Error('MCP unavailable'), null, [{ id: 'wrong-id' }]]) {
    await assert.rejects(service.recoverMemoryProjections());
    assert.deepEqual(store.getMessage(started.assistantMessage.id).memoryCandidate, candidate);
  }
});

test('persisted reply loads canonical history and enriches the terminal done event', async () => {
  const requests = [];
  const { service, store } = createFixture(async (request, { emit }) => {
    requests.push(request);
    emit({ type: 'run', data: { run: { id: 'run-1', status: 'running' } } });
    emit({ type: 'token', data: { token: '持久化' } });
    emit({ type: 'tool', data: {
      id: 'tool-1', name: 'search', args: { query: 'React' }, status: 'running'
    } });
    emit({ type: 'tool', data: {
      id: 'tool-1', name: 'search', args: { query: 'React' }, status: 'success', result: '找到资料'
    } });
    emit({ type: 'citations', data: {
      citations: [{ id: 'citation-1', title: 'React', snippet: '资料', source: 'local' }]
    } });
    emit({ type: 'memory_candidate', data: {
      candidate: { id: 'memory-1', title: '回答偏好', content: '使用中文' }
    } });
    emit({ type: 'run', data: { run: { id: 'run-1', status: 'success' } } });
    emit({ type: 'done', data: {
      citations: [{ id: 'citation-1', title: 'React', snippet: '资料', source: 'local' }],
      tools: [{ id: 'tool-1', name: 'search', args: { query: 'React' }, status: 'success', result: '找到资料' }],
      run: { id: 'run-1', status: 'success' }
    } });
    return { status: 'success', run: { id: 'run-1', status: 'success' } };
  });

  const reply = service.openReply(input());
  assert.equal(reply.accepted.session.id, 'session-1');
  assert.equal(reply.accepted.userMessage.id, 'user-2');
  assert.equal(reply.accepted.assistantMessage.id, 'assistant-3');

  const events = [];
  await reply.run({
    signal: new AbortController().signal,
    emit(event) {
      events.push(event);
    }
  });

  assert.deepEqual(requests[0].messages, [{
    id: 'user-2', role: 'user', content: '第一轮问题'
  }]);
  assert.equal(requests[0].conversationId, 'session-1');
  assert.equal(requests[0].presetId, 'documents');
  assert.equal(requests[0].ragEnabled, true);
  assert.deepEqual(requests[0].knowledgeBaseIds, ['kb-project']);
  assert.deepEqual(requests[0].sourceMessageIds, ['user-2', 'assistant-3']);

  const finalMessage = store.getMessage('assistant-3');
  assert.equal(finalMessage.status, 'done');
  assert.equal(finalMessage.content, '持久化');
  assert.equal(finalMessage.runId, 'run-1');
  assert.equal(finalMessage.tools.length, 1);
  assert.equal(finalMessage.tools[0].status, 'success');
  assert.equal(finalMessage.citations[0].id, 'citation-1');
  assert.equal(finalMessage.memoryCandidate.id, 'memory-1');
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.data.message.id, finalMessage.id);
  assert.equal(done.data.message.status, 'done');

  const reviewedMemory = service.updateMessageMemoryCandidate('assistant-3', {
    ...finalMessage.memoryCandidate,
    status: 'confirmed'
  });
  assert.equal(reviewedMemory.status, 'done');
  assert.equal(reviewedMemory.memoryCandidate.status, 'confirmed');
  store.close();
});

test('subsequent replies use persisted completed history rather than client-provided messages', async () => {
  const requests = [];
  const { service, store } = createFixture(async (request, { emit }) => {
    requests.push(request);
    emit({ type: 'token', data: { token: `回答 ${requests.length}` } });
    emit({ type: 'done', data: { citations: [], tools: [], run: null } });
    return { status: 'success', run: null };
  });

  const first = service.openReply(input());
  await first.run({ signal: new AbortController().signal, emit() {} });
  const second = service.openReply(input({
    sessionId: first.accepted.session.id,
    requestId: 'request-2',
    content: '第二轮问题',
    presetId: 'forged-client-value',
    ragEnabled: false,
    knowledgeBaseIds: []
  }));
  await second.run({ signal: new AbortController().signal, emit() {} });

  assert.deepEqual(requests[1].messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '回答 1' },
    { role: 'user', content: '第二轮问题' }
  ]);
  assert.equal(requests[1].presetId, 'documents');
  assert.equal(requests[1].ragEnabled, true);
  assert.deepEqual(requests[1].knowledgeBaseIds, ['kb-project']);
  store.close();
});

test('error and cancellation paths preserve partial output in distinct terminal states', async () => {
  const { service, store } = createFixture(async (request, { emit }) => {
    emit({ type: 'token', data: { token: request.messages.at(-1).content } });
    emit({ type: 'run', data: { run: { id: `run-${request.messages.length}`, status: 'error' } } });
    if (request.messages.at(-1).content === '失败问题') {
      emit({ type: 'error', data: {
        code: 'MODEL_FAILED', message: '模型失败', details: '上游不可用'
      } });
      return {
        status: 'error',
        run: { id: `run-${request.messages.length}`, status: 'error' },
        error: { code: 'MODEL_FAILED', message: '模型失败', details: '上游不可用' }
      };
    }
    return {
      status: 'cancelled',
      run: { id: `run-${request.messages.length}`, status: 'cancelled' }
    };
  });

  const failed = service.openReply(input({ content: '失败问题' }));
  const failedEvents = [];
  await failed.run({
    signal: new AbortController().signal,
    emit: (event) => failedEvents.push(event)
  });
  const failedMessage = store.getMessage(failed.accepted.assistantMessage.id);
  assert.equal(failedMessage.status, 'error');
  assert.equal(failedMessage.content, '失败问题');
  assert.equal(failedMessage.errorCode, 'MODEL_FAILED');
  assert.equal(failedEvents.find((event) => event.type === 'error').data.message.status, 'error');

  const failedReplay = service.openReply(input({ content: '失败问题' }));
  const replayEvents = [];
  await failedReplay.run({
    signal: new AbortController().signal,
    emit: (event) => replayEvents.push(event)
  });
  assert.equal(replayEvents[0].type, 'error');
  assert.equal(replayEvents[0].data.message.status, 'error');

  const cancelled = service.openReply(input({
    sessionId: failed.accepted.session.id,
    requestId: 'request-2',
    content: '取消问题'
  }));
  await cancelled.run({ signal: new AbortController().signal, emit() {} });
  const cancelledMessage = store.getMessage(cancelled.accepted.assistantMessage.id);
  assert.equal(cancelledMessage.status, 'cancelled');
  assert.equal(cancelledMessage.content, '取消问题');
  store.close();
});

test('only one reply runtime can be active and completed requests replay without rerunning', async () => {
  let releaseFirst;
  let runs = 0;
  const { service, store } = createFixture(async (_request, { emit }) => {
    runs += 1;
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    emit({ type: 'token', data: { token: '完成' } });
    emit({ type: 'done', data: { citations: [], tools: [], run: null } });
    return { status: 'success', run: null };
  });

  const first = service.openReply(input());
  const running = first.run({ signal: new AbortController().signal, emit() {} });
  await Promise.resolve();
  assert.throws(
    () => service.openReply(input({ requestId: 'request-2', content: '并发问题' })),
    (error) => error.code === 'CHAT_STREAM_ACTIVE' && error.status === 409
  );
  releaseFirst();
  await running;

  const replay = service.openReply(input());
  const replayEvents = [];
  await replay.run({
    signal: new AbortController().signal,
    emit: (event) => replayEvents.push(event)
  });
  assert.equal(runs, 1);
  assert.equal(replay.accepted.reused, true);
  assert.equal(replayEvents.at(-1).type, 'done');
  assert.equal(replayEvents.at(-1).data.message.status, 'done');
  store.close();
});
