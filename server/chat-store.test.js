import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createChatStore } from './chat-store.js';

function temporaryDatabasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-agent-chat-'));
  return path.join(directory, 'chat.sqlite');
}

function createFixture(dbPath = temporaryDatabasePath()) {
  let nextId = 0;
  let timestamp = 1_000;
  const store = createChatStore(dbPath, {
    createId(prefix) {
      nextId += 1;
      return `${prefix}-${nextId}`;
    },
    now() {
      timestamp += 1;
      return timestamp;
    }
  });
  return { dbPath, store };
}

function startTurn(store, overrides = {}) {
  return store.startTurn({
    requestId: 'request-1',
    content: '请解释 React Chat 的持久化方案。',
    presetId: 'general',
    ragEnabled: true,
    knowledgeBaseIds: ['kb-default'],
    ...overrides
  });
}

test('first send atomically creates one session and its user/assistant messages', () => {
  const { store } = createFixture();
  assert.deepEqual(store.listSessions(), []);

  const started = startTurn(store);

  assert.equal(started.reused, false);
  assert.equal(started.session.title, '请解释 React Chat 的持久化方案。');
  assert.equal(started.session.presetId, 'general');
  assert.equal(started.session.ragEnabled, true);
  assert.deepEqual(started.session.knowledgeBaseIds, ['kb-default']);
  assert.equal(started.userMessage.role, 'user');
  assert.equal(started.userMessage.status, 'done');
  assert.equal(started.userMessage.sequenceNo, 1);
  assert.equal(started.assistantMessage.role, 'assistant');
  assert.equal(started.assistantMessage.status, 'streaming');
  assert.equal(started.assistantMessage.sequenceNo, 2);
  assert.equal(started.userMessage.requestId, 'request-1');
  assert.equal(started.assistantMessage.requestId, 'request-1');

  const sessions = store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messageCount, 2);
  assert.equal(store.listMessages(started.session.id).messages.length, 2);
  store.close();
});

test('a first-send retry reuses the original session and turn', () => {
  const { store } = createFixture();
  const first = startTurn(store);
  const retried = startTurn(store, {
    content: '网络重试不应创建另一份内容。'
  });

  assert.equal(retried.reused, true);
  assert.equal(retried.session.id, first.session.id);
  assert.equal(retried.userMessage.id, first.userMessage.id);
  assert.equal(retried.userMessage.content, first.userMessage.content);
  assert.equal(retried.assistantMessage.id, first.assistantMessage.id);
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.listMessages(first.session.id).messages.length, 2);
  store.close();
});

test('existing sessions append stable sequences and page backward in groups of 100', () => {
  const { store } = createFixture();
  const first = startTurn(store);

  for (let index = 2; index <= 105; index += 1) {
    startTurn(store, {
      sessionId: first.session.id,
      requestId: `request-${index}`,
      content: `第 ${index} 轮问题`
    });
  }

  const latest = store.listMessages(first.session.id);
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.messages[0].sequenceNo, 111);
  assert.equal(latest.messages[99].sequenceNo, 210);
  assert.equal(latest.nextCursor, 111);

  const middle = store.listMessages(first.session.id, {
    before: latest.nextCursor
  });
  assert.equal(middle.messages.length, 100);
  assert.equal(middle.messages[0].sequenceNo, 11);
  assert.equal(middle.messages[99].sequenceNo, 110);
  assert.equal(middle.nextCursor, 11);

  const oldest = store.listMessages(first.session.id, {
    before: middle.nextCursor
  });
  assert.deepEqual(
    oldest.messages.map((message) => message.sequenceNo),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(oldest.nextCursor, null);
  store.close();
});

test('assistant snapshots persist terminal metadata and reject terminal rewrites', () => {
  const { store } = createFixture();
  const started = startTurn(store);

  const completed = store.updateAssistantMessage(started.assistantMessage.id, {
    content: '这是最终回答。',
    status: 'done',
    citations: [{ id: 'citation-1', title: '资料', snippet: '片段', source: 'local' }],
    tools: [{ id: 'tool-1', name: 'search', args: {}, status: 'success' }],
    memoryCandidate: { id: 'memory-1', title: '偏好', content: '使用中文回答' },
    runId: 'run-1'
  });

  assert.equal(completed.content, '这是最终回答。');
  assert.equal(completed.status, 'done');
  assert.equal(completed.runId, 'run-1');
  assert.equal(completed.citations[0].id, 'citation-1');
  assert.equal(completed.tools[0].id, 'tool-1');
  assert.equal(completed.memoryCandidate.id, 'memory-1');
  assert.throws(
    () => store.updateAssistantMessage(completed.id, {
      content: '不允许覆盖终态',
      status: 'streaming'
    }),
    (error) => error.code === 'CHAT_MESSAGE_TERMINAL' && error.status === 409
  );
  store.close();
});

test('startup recovery keeps partial content and marks streaming messages interrupted', () => {
  const dbPath = temporaryDatabasePath();
  let fixture = createFixture(dbPath);
  const started = startTurn(fixture.store);
  fixture.store.updateAssistantMessage(started.assistantMessage.id, {
    content: '已经生成的部分内容',
    status: 'streaming'
  });
  fixture.store.close();

  fixture = createFixture(dbPath);
  const recovered = fixture.store.getMessage(started.assistantMessage.id);
  assert.equal(recovered.content, '已经生成的部分内容');
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.errorCode, 'PROCESS_RESTARTED');
  fixture.store.close();
});

test('session config updates are normalized and deletion cascades only chat messages', () => {
  const { store } = createFixture();
  const started = startTurn(store);
  const updated = store.updateSession(started.session.id, {
    presetId: 'documents',
    ragEnabled: false,
    knowledgeBaseIds: ['kb-project', 'kb-project', '', ' kb-team ']
  });

  assert.equal(updated.presetId, 'documents');
  assert.equal(updated.ragEnabled, false);
  assert.deepEqual(updated.knowledgeBaseIds, ['kb-project', 'kb-team']);
  assert.equal(store.deleteSession(started.session.id), true);
  assert.equal(store.getSession(started.session.id), null);
  assert.equal(store.getMessage(started.userMessage.id), null);
  assert.equal(store.deleteSession(started.session.id), false);
  store.close();
});

test('damaged JSON attachments degrade independently without hiding message content', () => {
  const dbPath = temporaryDatabasePath();
  let fixture = createFixture(dbPath);
  const started = startTurn(fixture.store);
  fixture.store.updateAssistantMessage(started.assistantMessage.id, {
    content: '正文应保持可读',
    status: 'done',
    citations: [{ id: 'citation-1' }],
    tools: [{ id: 'tool-1' }],
    memoryCandidate: { id: 'memory-1' }
  });
  fixture.store.close();

  const database = new DatabaseSync(dbPath);
  database.prepare(`
    UPDATE chat_messages
    SET citations_json = '{', tools_json = 'invalid', memory_candidate_json = '['
    WHERE id = ?
  `).run(started.assistantMessage.id);
  database.close();

  fixture = createFixture(dbPath);
  const message = fixture.store.getMessage(started.assistantMessage.id);
  assert.equal(message.content, '正文应保持可读');
  assert.deepEqual(message.citations, []);
  assert.deepEqual(message.tools, []);
  assert.equal(message.memoryCandidate, null);
  fixture.store.close();
});

test('memory projection synchronization updates and removes every matching candidate', () => {
  const { store } = createFixture();
  const started = startTurn(store);
  store.updateAssistantMessage(started.assistantMessage.id, {
    status: 'done',
    content: '好的。',
    memoryCandidate: { id: 'memory-1', title: '旧标题', status: 'candidate' }
  });

  assert.equal(store.syncMemoryCandidateProjection('memory-1', {
    id: 'memory-1', title: '新标题', status: 'confirmed'
  }), 1);
  assert.deepEqual(store.getMessage(started.assistantMessage.id).memoryCandidate, {
    id: 'memory-1', title: '新标题', status: 'confirmed'
  });

  assert.equal(store.syncMemoryCandidateProjection('memory-1', null), 1);
  assert.equal(store.getMessage(started.assistantMessage.id).memoryCandidate, null);
  store.close();
});
