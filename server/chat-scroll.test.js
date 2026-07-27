import assert from 'node:assert/strict';
import test from 'node:test';
import { isNearScrollBottom } from '../src/services/chat-scroll.ts';

test('isNearScrollBottom keeps auto-follow enabled near the bottom', () => {
  assert.equal(
    isNearScrollBottom({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 }),
    true
  );
});

test('isNearScrollBottom disables auto-follow after the user scrolls away', () => {
  assert.equal(
    isNearScrollBottom({ scrollTop: 650, clientHeight: 500, scrollHeight: 1500 }),
    false
  );
});

test('isNearScrollBottom tolerates short non-scrollable conversations', () => {
  assert.equal(
    isNearScrollBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 420 }),
    true
  );
});
