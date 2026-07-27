import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeChatEvent } from './chat-events.js';

test('chat events use the existing SSE event/data wire format', () => {
  assert.equal(
    encodeChatEvent({ type: 'token', data: { token: '你\n好' } }),
    'event: token\ndata: {"token":"你\\n好"}\n\n'
  );
  assert.equal(
    encodeChatEvent({ type: 'done', data: { citations: [], tools: [] } }),
    'event: done\ndata: {"citations":[],"tools":[]}\n\n'
  );
});
