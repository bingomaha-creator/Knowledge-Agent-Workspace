import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { createChatRouter } from './chat-routes.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function parseEvents(text) {
  return text.trim().split(/\n\n/).map((block) => {
    const lines = block.split('\n');
    return {
      type: lines.find((line) => line.startsWith('event: ')).slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6))
    };
  });
}

test('chat route owns SSE headers/body mapping while the orchestrator owns domain events', async (t) => {
  const calls = [];
  const chatRouter = createChatRouter({
    orchestrator: {
      async run(request, { signal, emit }) {
        calls.push({ request, signal });
        emit({ type: 'run', data: { run: { id: 'run-1', status: 'running' } } });
        emit({ type: 'token', data: { token: '你好' } });
        emit({ type: 'done', data: { citations: [], tools: [], run: { id: 'run-1', status: 'success' } } });
        return { status: 'success', run: { id: 'run-1', status: 'success' } };
      }
    }
  });
  const server = await listen(createApp({ chatRouter }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: '你好' }],
      ragEnabled: false
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.deepEqual(parseEvents(await response.text()).map((event) => event.type), [
    'run',
    'token',
    'done'
  ]);
  assert.equal(calls[0].request.conversationId, 'conversation-1');
  assert.equal(calls[0].signal instanceof AbortSignal, true);
});

test('persisted chat routes expose session CRUD, cursor messages, and accepted-first SSE', async (t) => {
  const calls = [];
  const session = {
    id: 'session-1',
    title: '持久化会话',
    presetId: 'general',
    ragEnabled: true,
    knowledgeBaseIds: [],
    messageCount: 2,
    createdAt: 1,
    updatedAt: 2
  };
  const userMessage = {
    id: 'user-1', sessionId: session.id, requestId: 'request-1',
    sequenceNo: 1, role: 'user', content: '你好', status: 'done'
  };
  const assistantMessage = {
    id: 'assistant-1', sessionId: session.id, requestId: 'request-1',
    sequenceNo: 2, role: 'assistant', content: '', status: 'streaming'
  };
  const chatService = {
    listSessions() {
      calls.push(['listSessions']);
      return [session];
    },
    getSession(id) {
      calls.push(['getSession', id]);
      return id === session.id ? session : null;
    },
    listMessages(id, options) {
      calls.push(['listMessages', id, options]);
      return { messages: [userMessage, assistantMessage], nextCursor: 1 };
    },
    getMessage(id) {
      calls.push(['getMessage', id]);
      return id === userMessage.id ? userMessage : null;
    },
    updateMessageMemoryCandidate(id, memoryCandidate) {
      calls.push(['updateMessageMemoryCandidate', id, memoryCandidate]);
      return { ...assistantMessage, memoryCandidate };
    },
    updateSession(id, patch) {
      calls.push(['updateSession', id, patch]);
      return { ...session, ...patch };
    },
    deleteSession(id) {
      calls.push(['deleteSession', id]);
      return id === session.id;
    },
    openReply(body) {
      calls.push(['openReply', body]);
      return {
        accepted: {
          reused: false,
          session,
          userMessage,
          assistantMessage
        },
        async run({ signal, emit }) {
          calls.push(['run', signal]);
          emit({ type: 'token', data: { token: '你好' } });
          emit({ type: 'done', data: {
            citations: [], tools: [], run: null,
            message: { ...assistantMessage, content: '你好', status: 'done' }
          } });
        }
      };
    }
  };
  const chatRouter = createChatRouter({
    chatService,
    orchestrator: { async run() {} }
  });
  const server = await listen(createApp({ chatRouter }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let response = await fetch(`${baseUrl}/api/chat/sessions`);
  assert.deepEqual(await response.json(), { sessions: [session] });

  response = await fetch(`${baseUrl}/api/chat/sessions/session-1`);
  assert.deepEqual(await response.json(), { session });

  response = await fetch(`${baseUrl}/api/chat/sessions/session-1/messages?before=101&limit=100`);
  assert.deepEqual(await response.json(), {
    messages: [userMessage, assistantMessage], nextCursor: 1
  });
  assert.deepEqual(
    calls.find((call) => call[0] === 'listMessages'),
    ['listMessages', 'session-1', { before: '101', limit: '100' }]
  );

  response = await fetch(`${baseUrl}/api/chat/messages/user-1`);
  assert.deepEqual(await response.json(), { message: userMessage });

  response = await fetch(`${baseUrl}/api/chat/messages/assistant-1/memory-candidate`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memoryCandidate: { id: 'memory-1', status: 'confirmed' } })
  });
  assert.equal((await response.json()).message.memoryCandidate.status, 'confirmed');

  response = await fetch(`${baseUrl}/api/chat/sessions/session-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ragEnabled: false, knowledgeBaseIds: ['kb-project'] })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session.ragEnabled, false);

  response = await fetch(`${baseUrl}/api/chat/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'request-1', content: '你好' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(parseEvents(await response.text()).map((event) => event.type), [
    'accepted',
    'token',
    'done'
  ]);

  response = await fetch(`${baseUrl}/api/chat/sessions/session-1`, {
    method: 'DELETE'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
});

test('persisted stream validation fails as JSON before SSE headers are sent', async (t) => {
  const error = new Error('消息内容不能为空');
  error.code = 'CHAT_EMPTY_MESSAGE';
  error.status = 400;
  const chatRouter = createChatRouter({
    chatService: {
      openReply() {
        throw error;
      }
    },
    orchestrator: { async run() {} }
  });
  const server = await listen(createApp({ chatRouter }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${port}/api/chat/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '' })
  });

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), {
    error: '消息内容不能为空',
    code: 'CHAT_EMPTY_MESSAGE',
    details: ''
  });
});
