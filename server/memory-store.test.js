import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryFingerprint, createMemoryStore } from './memory-store.js';

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-agent-memory-'));
  return path.join(directory, 'pitfalls.sqlite');
}

function sample(overrides = {}) {
  return {
    id: 'memory-1',
    type: 'preference',
    title: '回答偏好',
    content: '用户偏好简洁的中文回答。',
    details: { language: 'zh-CN' },
    confidence: 0.88,
    status: 'candidate',
    sourceConversationId: 'session-1',
    sourceMessageIds: ['user-1', 'assistant-1'],
    sourceExcerpt: '用户：请用简洁中文回答。',
    embedding: [0.1, 0.2],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

test('memory store persists candidates and confirmation metadata', () => {
  const dbPath = tempDbPath();
  const first = createMemoryStore(dbPath);
  const inserted = first.insertMemory(sample());
  assert.equal(inserted.status, 'candidate');
  assert.deepEqual(inserted.sourceMessageIds, ['user-1', 'assistant-1']);

  const confirmed = first.updateMemory(inserted.id, { status: 'confirmed' });
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmedAt);
  first.close();

  const reopened = createMemoryStore(dbPath);
  assert.equal(reopened.getMemory(inserted.id).status, 'confirmed');
  assert.equal(reopened.listRetrievableMemories().length, 1);
  reopened.close();
});

test('only confirmed and corrected memories are retrievable', () => {
  const store = createMemoryStore(tempDbPath());
  store.insertMemory(sample({ id: 'candidate', title: '候选', content: '候选内容' }));
  store.insertMemory(sample({ id: 'confirmed', title: '确认', content: '确认内容', status: 'confirmed' }));
  store.insertMemory(sample({ id: 'corrected', title: '纠正', content: '纠正内容', status: 'corrected' }));
  store.insertMemory(sample({ id: 'rejected', title: '拒绝', content: '拒绝内容', status: 'rejected' }));

  assert.deepEqual(
    store.listRetrievableMemories().map((memory) => memory.id).sort(),
    ['confirmed', 'corrected']
  );
  store.close();
});

test('memory store filters by type, status and query', () => {
  const store = createMemoryStore(tempDbPath());
  store.insertMemory(sample({ id: 'event-1', type: 'event', title: '上海会议', content: '去年六月参加会议。', status: 'confirmed' }));
  store.insertMemory(sample({ id: 'fact-1', type: 'fact', title: '工作地点', content: '用户在深圳工作。', status: 'confirmed' }));

  assert.equal(store.listMemories({ types: ['event'] }).length, 1);
  assert.equal(store.listMemories({ statuses: ['confirmed'], query: '深圳' })[0].id, 'fact-1');
  store.close();
});

test('memory store rejects active duplicate fingerprints but allows rejected history', () => {
  const store = createMemoryStore(tempDbPath());
  store.insertMemory(sample());
  assert.throws(
    () => store.insertMemory(sample({ id: 'memory-2' })),
    (error) => error.code === 'MEMORY_DUPLICATE'
  );
  store.updateMemory('memory-1', { status: 'rejected' });
  assert.equal(store.insertMemory(sample({ id: 'memory-2' })).id, 'memory-2');
  store.close();
});

test('legacy pitfall rows migrate to confirmed pitfall memories', () => {
  const dbPath = tempDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE pitfall_memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      symptom TEXT NOT NULL,
      cause TEXT NOT NULL,
      solution TEXT NOT NULL,
      lesson TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      source_messages TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO pitfall_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'pitfall-1', 'SSE 分片', 'JSON 解析失败', '事件跨 chunk', '先 buffer',
    '不要逐 chunk 解析', '["SSE"]', '用户与助手原文', '[0.1,0.2]', 1000, 1100
  );
  db.close();

  const store = createMemoryStore(dbPath);
  const migrated = store.getMemory('pitfall-1');
  assert.equal(migrated.type, 'pitfall');
  assert.equal(migrated.status, 'confirmed');
  assert.equal(migrated.confidence, 0.9);
  assert.equal(migrated.details.solution, '先 buffer');
  assert.equal(migrated.sourceExcerpt, '用户与助手原文');
  store.deleteMemory('pitfall-1');
  store.close();

  const reopened = createMemoryStore(dbPath);
  assert.equal(reopened.listMemories().length, 0, 'deleted migrated rows must not resurrect');
  reopened.close();
});

test('legacy migration truncates oversized rows instead of blocking startup', () => {
  const dbPath = tempDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE pitfall_memories (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, symptom TEXT NOT NULL,
      cause TEXT NOT NULL, solution TEXT NOT NULL, lesson TEXT NOT NULL,
      tags_json TEXT NOT NULL, source_messages TEXT NOT NULL,
      embedding_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO pitfall_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'legacy-large', '标题'.repeat(200), '现象'.repeat(3000), '根因'.repeat(3000),
    '方案'.repeat(3000), '经验'.repeat(3000), JSON.stringify(['标签'.repeat(100)]),
    '来源'.repeat(10000), JSON.stringify(Array.from({ length: 9000 }, () => 0.1)), 1, 2
  );
  db.close();

  const store = createMemoryStore(dbPath);
  const migrated = store.getMemory('legacy-large');
  assert.ok(migrated.title.length <= 160);
  assert.ok(migrated.content.length <= 8000);
  assert.ok(migrated.sourceExcerpt.length <= 12000);
  assert.ok(migrated.embedding.length <= 8192);
  store.close();
});

test('legacy migration budgets JSON escaping in structured details', () => {
  const dbPath = tempDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE pitfall_memories (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, symptom TEXT NOT NULL,
      cause TEXT NOT NULL, solution TEXT NOT NULL, lesson TEXT NOT NULL,
      tags_json TEXT NOT NULL, source_messages TEXT NOT NULL,
      embedding_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const escaped = '"'.repeat(4000);
  db.prepare('INSERT INTO pitfall_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'legacy-escaped', '转义字符', escaped, escaped, escaped, escaped,
    JSON.stringify([escaped]), '', '[]', 1, 2
  );
  db.close();

  const store = createMemoryStore(dbPath);
  const migrated = store.getMemory('legacy-escaped');
  assert.ok(migrated);
  assert.ok(JSON.stringify(migrated.details).length <= 16000);
  store.close();
});

test('internal memory state can load every row independently of list limits', () => {
  const store = createMemoryStore(tempDbPath());
  store.insertMemory(sample({ id: 'one', title: '一', content: '内容一' }));
  store.insertMemory(sample({ id: 'two', title: '二', content: '内容二' }));
  assert.equal(store.listMemories({ limit: 1 }).length, 1);
  assert.equal(store.listMemories({ limit: 1, offset: 1 }).length, 1);
  assert.equal(store.countMemories(), 2);
  assert.equal(store.listAllMemories().length, 2);
  store.close();
});

test('memory fingerprint keeps semantic technology symbols', () => {
  assert.notEqual(
    createMemoryFingerprint(sample({ title: 'C++ 编译', content: 'C++ 构建失败' })),
    createMemoryFingerprint(sample({ title: 'C# 编译', content: 'C# 构建失败' }))
  );
});

test('memory store enforces persistence size and embedding boundaries', () => {
  const store = createMemoryStore(tempDbPath());
  assert.throws(
    () => store.insertMemory(sample({ content: 'x'.repeat(8001) })),
    (error) => error.code === 'MEMORY_TOO_LARGE' && error.status === 413
  );
  assert.throws(
    () => store.insertMemory(sample({ embedding: [0.1, Number.NaN] })),
    (error) => error.code === 'INVALID_EMBEDDING'
  );
  store.close();
});
