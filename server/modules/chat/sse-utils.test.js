import assert from 'node:assert/strict';
import test from 'node:test';
import { drainSseData } from './sse-utils.js';

test('drainSseData keeps incomplete events in the remainder', () => {
  const result = drainSseData('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(result.data, ['{"a":1}']);
  assert.equal(result.remainder, 'data: {"b"');
});

test('drainSseData flushes a final event without a trailing blank line', () => {
  const result = drainSseData('data: {"a":1}', { flush: true });
  assert.deepEqual(result.data, ['{"a":1}']);
  assert.equal(result.remainder, '');
});

test('drainSseData joins multiline data fields', () => {
  const result = drainSseData('data: first\ndata: second\n\n');
  assert.deepEqual(result.data, ['first\nsecond']);
});
