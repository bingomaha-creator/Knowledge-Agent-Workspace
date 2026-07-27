import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryStore } from '../memory-store.js';
import { createMemoryService } from './memory-service.js';

test('memory service never recalls candidates and recalls confirmed/corrected records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-service-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createMemoryService({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });

  const proposed = await service.proposeMemory({
    type: 'fact',
    title: '项目测试规则',
    content: '每批重构都要跑真实进程测试。',
    confidence: 0.9
  });
  assert.equal(proposed.duplicate, false);
  assert.equal(proposed.memory.status, 'candidate');
  assert.deepEqual(await service.searchMemories('真实进程测试'), []);

  await service.updateMemory(proposed.memory.id, { status: 'confirmed' });
  const confirmed = await service.searchMemories('真实进程测试');
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].id, proposed.memory.id);

  await service.updateMemory(proposed.memory.id, {
    status: 'corrected',
    content: '每批重构都要跑完整回归。'
  });
  const corrected = await service.searchMemories('完整回归');
  assert.equal(corrected[0].status, 'corrected');
});

test('memory service creates an explicitly authored memory as immediately retrievable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-create-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createMemoryService({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });

  const created = await service.createMemory({
    type: 'preference',
    title: '回答风格',
    content: '回答时先给结论，再解释原因。',
    confidence: 1
  });

  assert.equal(created.duplicate, false);
  assert.equal(created.memory.status, 'confirmed');
  assert.ok(created.memory.confirmedAt);
  assert.equal((await service.searchMemories('回答风格'))[0]?.id, created.memory.id);
});

test('explicit creation confirms an existing identical candidate instead of leaving it pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-promote-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createMemoryService({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });
  const input = {
    type: 'fact',
    title: '项目技术栈',
    content: '项目使用 Vue 3。'
  };
  const proposed = await service.proposeMemory(input);

  const created = await service.createMemory(input);

  assert.equal(created.duplicate, true);
  assert.equal(created.memory.id, proposed.memory.id);
  assert.equal(created.memory.status, 'confirmed');
});

test('memory service supports all five types and only recalls relevant reviewed records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-types-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const vocabulary = ['前端开发', '回答风格', '项目技术栈', '秋招节点', 'SSE 分块'];
  const service = createMemoryService({
    store,
    embeddingClient: {
      async embed(text) {
        return vocabulary.map((term) => String(text).includes(term) ? 1 : 0);
      }
    },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });
  const inputs = [
    { type: 'profile', title: '职业画像', content: '用户是一名前端开发。' },
    { type: 'preference', title: '回答风格', content: '回答时先给结论。' },
    { type: 'fact', title: '项目技术栈', content: '项目使用 Vue 3。' },
    { type: 'event', title: '秋招节点', content: '计划八月完成项目版本。' },
    { type: 'pitfall', title: 'SSE 分块', content: '不能逐个 chunk 直接解析 JSON。' }
  ];

  const created = [];
  for (const input of inputs) created.push((await service.createMemory(input)).memory);

  assert.deepEqual(
    new Set(service.listMemories({}).map((memory) => memory.type)),
    new Set(['profile', 'preference', 'fact', 'event', 'pitfall'])
  );
  assert.deepEqual(
    (await service.searchMemories('回答风格')).map((memory) => memory.id),
    [created[1].id]
  );
  assert.deepEqual(
    (await service.searchMemories('完全无关的天气预报')).map((memory) => memory.id),
    [created[1].id]
  );

  await service.updateMemory(created[4].id, { status: 'rejected' });
  assert.deepEqual(
    (await service.searchMemories('SSE 分块')).map((memory) => memory.id),
    [created[1].id]
  );
});

test('memory service only recalls pitfall memories for diagnostic questions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-recall-policy-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createMemoryService({
    store,
    embeddingClient: {
      async embed(text) {
        const source = String(text);
        return [
          source.includes('前端') ? 1 : 0,
          source.includes('流式') ? 1 : 0,
          source.includes('回答') ? 1 : 0
        ];
      }
    },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });
  const preference = (await service.createMemory({
    type: 'preference',
    title: '回答风格',
    content: '回答时先给结论，再解释原因。'
  })).memory;
  const profile = (await service.createMemory({
    type: 'profile',
    title: '技术方向',
    content: '用户正在准备前端方向的求职项目。'
  })).memory;
  const pitfall = (await service.createMemory({
    type: 'pitfall',
    title: '流式响应解析',
    content: '前端流式响应不能逐个 chunk 直接 JSON.parse。'
  })).memory;

  assert.deepEqual(
    new Set((await service.searchMemories('帮我规划前端项目')).map((memory) => memory.id)),
    new Set([preference.id, profile.id])
  );
  assert.ok(
    (await service.searchMemories('前端流式响应解析报错，如何排查')).some(
      (memory) => memory.id === pitfall.id
    )
  );
});

test('memory service keeps exact duplicate proposals idempotent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-memory-duplicate-'));
  const store = createMemoryStore(path.join(root, 'memory.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createMemoryService({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    embeddingModel: 'test-embedding',
    logger: { error() {} }
  });
  const input = {
    type: 'preference',
    title: '回答语言',
    content: '默认使用中文回答。'
  };

  const first = await service.proposeMemory(input);
  const second = await service.proposeMemory(input);
  assert.equal(second.duplicate, true);
  assert.equal(second.memory.id, first.memory.id);
  assert.equal(service.countMemories({}), 1);
});
