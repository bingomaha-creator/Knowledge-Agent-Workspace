import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.js';
import { createMemoryRouter } from './memory-routes.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

test('Memory HTTP adapter creates an explicitly authored memory as confirmed', async (t) => {
  const calls = [];
  const confirmed = {
    id: 'memory-1',
    type: 'preference',
    title: '回答风格',
    content: '回答时先给结论，再解释原因。',
    details: {},
    confidence: 1,
    status: 'confirmed'
  };
  const router = createMemoryRouter({
    callMcpTool: async (name, input) => {
      calls.push([name, input]);
      return { memory: confirmed };
    }
  });
  const server = await listen(createApp({ memoryRouter: router }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${port}/api/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'preference',
      title: '  回答风格  ',
      content: '  回答时先给结论，再解释原因。  ',
      confidence: 0.4,
      status: 'candidate',
      sourceExcerpt: '不应由浏览器注入'
    })
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { memory: confirmed });
  assert.deepEqual(calls, [[
    'create_memory',
    {
      type: 'preference',
      title: '回答风格',
      content: '回答时先给结论，再解释原因。',
      confidence: 1
    }
  ]]);
});

test('Memory HTTP adapter reads one memory and synchronizes Chat projections', async (t) => {
  const calls = [];
  const projections = [];
  const memory = {
    id: 'memory-1', type: 'fact', title: '项目技术栈', content: '使用 React。',
    details: {}, confidence: 0.9, status: 'candidate'
  };
  const router = createMemoryRouter({
    async callMcpTool(name, input) {
      calls.push([name, input]);
      if (name === 'list_memories') return { memories: [memory], total: 1 };
      if (name === 'update_memory') return { memory: { ...memory, status: input.status } };
      return { ok: true };
    },
    syncMemoryProjection(id, nextMemory) {
      projections.push([id, nextMemory]);
    }
  });
  const server = await listen(createApp({ memoryRouter: router }));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const detail = await fetch(`${baseUrl}/api/memories/memory-1`);
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { memory });
  assert.deepEqual(calls[0], ['list_memories', { ids: ['memory-1'], limit: 1, offset: 0 }]);

  const updated = await fetch(`${baseUrl}/api/memories/memory-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'confirmed' })
  });
  assert.equal(updated.status, 200);
  assert.equal(projections[0][0], 'memory-1');
  assert.equal(projections[0][1].status, 'confirmed');

  const removed = await fetch(`${baseUrl}/api/memories/memory-1`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(projections[1], ['memory-1', null]);
});

test('Memory HTTP adapter returns a stable not-found response for a missing detail', async (t) => {
  const router = createMemoryRouter({
    async callMcpTool() {
      return { memories: [], total: 0 };
    }
  });
  const server = await listen(createApp({ memoryRouter: router }));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${port}/api/memories/missing`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'MEMORY_NOT_FOUND');
});
