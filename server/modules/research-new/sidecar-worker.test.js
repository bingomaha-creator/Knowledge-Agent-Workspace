import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createResearchNewSidecarWorker } from './sidecar-worker.js';
import { createResearchNewStore } from './store.js';

function fixture(t, client) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-sidecar-worker-'));
  const store = createResearchNewStore(path.join(directory, 'research.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, worker: createResearchNewSidecarWorker({ store, client, pollMs: 1 }) };
}

test('Sidecar worker 不启动或恢复旧 Node 任务，仍可查看并取消历史任务', async (t) => {
  const { store, worker } = fixture(t, {
    startRun: async () => assert.fail('旧 Node 任务不能交给 Sidecar 执行'),
    cancelRun: async () => assert.fail('旧 Node 任务没有远端 Sidecar Run')
  });
  const queued = store.create({ question: '旧排队任务', mode: 'web', engine: 'node' });
  const running = store.claim(store.create({ question: '旧运行任务', mode: 'web', engine: 'node' }).id);
  assert.equal((await worker.enqueue(queued.id)).status, 'queued');
  await worker.resume();
  assert.equal(store.get(queued.id).status, 'queued');
  assert.equal(store.get(running.id).status, 'running');
  assert.equal(store.get(running.id).attempt, running.attempt);
  assert.equal(worker.cancel(queued.id).status, 'cancelled');
  assert.equal(worker.cancel(running.id).status, 'cancelled');
  assert.equal(store.get(running.id).question, '旧运行任务');
});

test('Sidecar worker 持久化映射并投影报告、来源与证据', async (t) => {
  let polls = 0;
  const client = {
    startRun: async () => ({ sessionId: 'session-1', runId: 'remote-1' }),
    getRun: async () => (++polls === 1
      ? { status: 'executing', current_stage: 'executing' }
      : {
          status: 'completed', current_stage: 'completed',
          usage: {
            limits: { max_replans: 2, max_tool_calls: 30 },
            usage: { replans: 0, tool_calls: 2 }
          }
        }),
    getEvidence: async () => ({ items: [{
      evidence_id: 'ev-1', task_id: 'track-1', source_mode: 'graphrag', provider: 'neo4j',
      source_id: 'doc-1', title: '架构文档', summary: '模块使用深模块边界。',
      metadata: { source_type: 'chunk', extra: { document_id: 'architecture.md', chunk_id: 'chunk-7', position: 7 } },
      content_hash: 'content-hash', artifact_id: null, score: 0.9
    }] }),
    getReport: async () => ({
      content: '# 研究报告\n\n结论。', report_mode: 'normal',
      verification: [{ check_id: 'citations', required: true, passed: true }]
    }),
    cancelRun: async () => ({ status: 'cancelling' })
  };
  const { store, worker } = fixture(t, client);
  const created = store.create({
    question: '项目采用了什么模块边界？', mode: 'hybrid', knowledgeBaseIds: ['kb-a'], engine: 'sidecar'
  });
  const completed = await worker.enqueue(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.report, '# 研究报告\n\n结论。');
  assert.equal(completed.resultQuality, 'sufficient');
  assert.deepEqual(completed.diagnostics.sidecar.sessionId, 'session-1');
  assert.deepEqual(completed.diagnostics.sidecar.runId, 'remote-1');
  assert.equal(completed.sources[0].documentId, 'architecture.md');
  assert.equal(completed.sources[0].chunkId, 'chunk-7');
  assert.equal(completed.sources[0].contentLevel, 'full_text');
  assert.equal(completed.evidence[0].passage, '模块使用深模块边界。');
  assert.equal(completed.budget.searchCalls, 2);
  assert.equal(completed.budget.maxSearchCalls, 30);
  assert.equal(completed.budget.sourcesRead, 1);
  assert.deepEqual(completed.diagnostics.sidecar.evidenceTrace, [{
    evidenceId: 'ev-1', documentId: 'architecture.md', chunkId: 'chunk-7',
    position: 7, contentHash: 'content-hash'
  }]);
});

test('Sidecar worker 收敛远端失败并转发取消', async (t) => {
  let cancelled = 0;
  const failedClient = {
    startRun: async () => ({ sessionId: 'session-2', runId: 'remote-2' }),
    getRun: async () => ({ status: 'failed', error_code: 'REMOTE_FAILED', error_message: '远端执行失败' }),
    cancelRun: async () => { cancelled += 1; }
  };
  const failedFixture = fixture(t, failedClient);
  const failedRun = failedFixture.store.create({ question: '失败用例', mode: 'web', engine: 'sidecar' });
  assert.equal((await failedFixture.worker.enqueue(failedRun.id)).status, 'failed');
  assert.match(failedFixture.store.get(failedRun.id).error, /远端执行失败/);

  let release;
  const runningClient = {
    startRun: async () => ({ sessionId: 'session-3', runId: 'remote-3' }),
    getRun: async () => new Promise((resolve) => { release = resolve; }),
    cancelRun: async () => { cancelled += 1; }
  };
  const runningFixture = fixture(t, runningClient);
  const running = runningFixture.store.create({ question: '取消用例', mode: 'web', engine: 'sidecar' });
  const promise = runningFixture.worker.enqueue(running.id);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  runningFixture.worker.cancel(running.id);
  release({ status: 'executing', current_stage: 'executing' });
  assert.equal((await promise).status, 'cancelled');
  assert.ok(cancelled >= 1);
});
