import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpSessionManager } from './mcp-session.js';

function createHarness({ failFirstConnect = false } = {}) {
  const clients = [];
  const transports = [];
  let connectAttempts = 0;
  const manager = createMcpSessionManager({
    clientInfo: { name: 'test-client', version: '1.0.0' },
    transportOptions: { command: 'node', args: ['fake-server.js'] },
    createClient(info) {
      const client = {
        info,
        closeCalls: 0,
        async connect(transport) {
          connectAttempts += 1;
          if (failFirstConnect && connectAttempts === 1) {
            throw new Error('connect failed');
          }
          this.transport = transport;
        },
        async close() {
          this.closeCalls += 1;
        }
      };
      clients.push(client);
      return client;
    },
    createTransport(options) {
      const transport = {
        options,
        closeCalls: 0,
        async close() {
          this.closeCalls += 1;
        }
      };
      transports.push(transport);
      return transport;
    },
    logger: { error() {} }
  });
  return { manager, clients, transports };
}

test('MCP session manager single-flights concurrent connection requests', async () => {
  const harness = createHarness();
  const [first, second] = await Promise.all([
    harness.manager.getSession(),
    harness.manager.getSession()
  ]);

  assert.equal(first, second);
  assert.equal(harness.clients.length, 1);
  assert.equal(harness.transports.length, 1);
  assert.deepEqual(harness.clients[0].info, { name: 'test-client', version: '1.0.0' });
});

test('failed MCP connection is not cached and the next request can rebuild it', async () => {
  const harness = createHarness({ failFirstConnect: true });
  await assert.rejects(harness.manager.getSession(), /connect failed/);

  const session = await harness.manager.getSession();
  assert.equal(session.client, harness.clients[1]);
  assert.equal(harness.clients.length, 2);
});

test('closed sessions rebuild and a late old onclose cannot clear the new session', async () => {
  const harness = createHarness();
  const first = await harness.manager.getSession();
  first.transport.onclose();

  const second = await harness.manager.getSession();
  assert.notEqual(first, second);
  first.transport.onclose();
  assert.equal(await harness.manager.getSession(), second);
  assert.equal(harness.clients.length, 2);
});

test('manager close invalidates the cache and closes both client and transport', async () => {
  const harness = createHarness();
  const first = await harness.manager.getSession();
  await harness.manager.close();

  assert.equal(first.client.closeCalls, 1);
  assert.equal(first.transport.closeCalls, 1);
  const second = await harness.manager.getSession();
  assert.notEqual(first, second);
});
