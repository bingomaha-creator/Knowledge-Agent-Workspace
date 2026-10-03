import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteMcpCaller } from './utils.js';

test('route MCP callers pin a server-owned caller and ignore forged caller arguments', async () => {
  const calls = [];
  const toolExecutor = {
    async callToolOrThrow(name, args, context, options) {
      calls.push({ name, args, context, options });
      return { structured: { ok: true } };
    }
  };
  const callKnowledgeTool = createRouteMcpCaller({ toolExecutor, caller: 'internal' });
  await callKnowledgeTool('ingest_knowledge_documents', { documents: [], caller: 'chat' });

  assert.deepEqual(calls[0].context, {
    caller: 'internal',
    invocation: 'explicit'
  });
  assert.equal(calls[0].args.caller, 'chat');
});
