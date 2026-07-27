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
