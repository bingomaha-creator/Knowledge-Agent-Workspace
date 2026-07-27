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
