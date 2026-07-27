import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteMcpCaller } from './http-utils.js';

test('route MCP callers pin a server-owned caller and ignore forged caller arguments', async () => {
  const calls = [];
  const toolExecutor = {
    async callToolOrThrow(name, args, context, options) {
      calls.push({ name, args, context, options });
      return { structured: { ok: true } };
    }
  };
  const callBugTool = createRouteMcpCaller({ toolExecutor, caller: 'bug-ui' });
  await callBugTool('create_bug_case', { title: 'x', caller: 'internal' });

  assert.deepEqual(calls[0].context, {
    caller: 'bug-ui',
    invocation: 'explicit'
  });
  assert.equal(calls[0].args.caller, 'internal');
});
