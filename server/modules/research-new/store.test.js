import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchNewStore } from './store.js';

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-new-store-'));
  const store = createResearchNewStore(path.join(directory, 'research-new.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('Research New 使用独立三表保存阶段快照、来源与证据', (t) => {
  const store = temporaryStore(t);
  const created = store.create({
    question: '对比两个版本',
    mode: 'hybrid',
    knowledgeBaseIds: ['kb-a']
  });
  const running = store.claim(created.id);
  assert.equal(running.status, 'running');
  assert.equal(running.attempt, 1);
  assert.equal(running.budget.maxWallTimeMs, 300_000);
  assert.equal(running.diagnostics.engine, 'node');

  const source = {
    id: 'source-1', trackId: 'track-1', origin: 'web', title: '官方说明',
    url: 'https://example.com/release', snippet: '摘要', query: '版本变化',
    sourceKind: 'official_docs', content: '完整正文', contentHash: 'hash-source',
    readerKind: 'web_page', contentLevel: 'full_text', fetchedAt: 123
  };
  const evidence = {
    id: 'E1', trackId: 'track-1', sourceId: source.id, origin: 'web', passage: '完整正文',
    passageHash: 'hash-passage', supports: ['版本发生变化'], contradicts: [],
    relevance: 0.9, sourceRole: 'primary_candidate', contentLevel: 'full_text'
  };
  const checkpoint = store.checkpoint(created.id, 1, {
    stage: 'reporting',
    progress: 70,
    brief: { objective: '版本对比' },
    tracks: [{ id: 'track-1', status: 'answered' }],
    sources: [source],
    evidence: [evidence],
    budget: { searchCalls: 1, sourcesRead: 1 }
  });
  assert.equal(checkpoint.sources[0].content, '完整正文');
  assert.equal(checkpoint.evidence[0].sourceId, 'source-1');
  assert.equal(checkpoint.budget.searchCalls, 1);

  const sourcesOnly = store.checkpoint(created.id, 1, {
    stage: 'reporting',
    sources: [source]
  });
  assert.equal(sourcesOnly.evidence.length, 1);

  const completed = store.complete(created.id, 1, {
    report: '结论 [E1]',
    resultQuality: 'sufficient'
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.report, '结论 [E1]');
  assert.equal(store.checkpoint(created.id, 1, { stage: 'verifying' }), null);
});

test('Research New 按执行引擎恢复任务', (t) => {
  const store = temporaryStore(t);
  const nodeRun = store.create({ question: 'Node', mode: 'web' });
  const sidecarRun = store.create({ question: 'Sidecar', mode: 'web', engine: 'sidecar' });
  assert.deepEqual(store.listRecoverable('node').map((run) => run.id), [nodeRun.id]);
  assert.deepEqual(store.listRecoverable('sidecar').map((run) => run.id), [sidecarRun.id]);
});

test('Research New 快照拒绝旧 attempt，取消不会被迟到完成覆盖', (t) => {
  const store = temporaryStore(t);
  const created = store.create({ question: '调查现状', mode: 'web' });
  const running = store.claim(created.id);
  assert.equal(store.checkpoint(created.id, running.attempt + 1, { stage: 'reporting' }), null);

  store.requestCancel(created.id);
  assert.equal(store.checkpoint(created.id, running.attempt, { stage: 'reporting' }), null);
  const cancelled = store.cancel(created.id, running.attempt);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(store.complete(created.id, running.attempt, { report: '迟到结果' }), null);
});
