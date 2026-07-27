import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createResearchStore } from './research-store.js';
import { createResearchWorker, verifyResearchReport } from './research-worker.js';

function temporaryDatabasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-'));
  return path.join(directory, 'research.sqlite');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('legacy research databases migrate additively and new fields survive reopen', () => {
  const dbPath = temporaryDatabasePath();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE research_tasks (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress INTEGER NOT NULL,
      error TEXT NOT NULL,
      report TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const insertLegacy = legacy.prepare('INSERT INTO research_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertLegacy.run(
    'research-legacy',
    '旧任务',
    'queued',
    'planning',
    0,
    '',
    '',
    '[]',
    10,
    10
  );
  insertLegacy.run(
    'research-legacy-completed',
    '旧完成任务',
    'completed',
    'completed',
    100,
    '',
    '# 历史报告',
    '[]',
    11,
    11
  );
  legacy.close();

  let store = createResearchStore(dbPath);
  assert.deepEqual(store.get('research-legacy'), {
    id: 'research-legacy',
    question: '旧任务',
    status: 'queued',
    stage: 'planning',
    progress: 0,
    error: '',
    report: '',
    citations: [],
    searchMode: 'local',
    webSearchStatus: 'not_requested',
    resultQuality: 'pending',
    limitations: [],
    failedStage: '',
    attempt: 0,
    cancelRequested: false,
    sessionId: 'research-legacy',
    parentTaskId: '',
    turnIndex: 1,
    continuationContext: null,
    knowledgeBaseIds: [],
    artifacts: {},
    createdAt: 10,
    updatedAt: 10,
    startedAt: null,
    finishedAt: null
  });
  const legacyCompleted = store.get('research-legacy-completed');
  assert.equal(legacyCompleted.resultQuality, 'limited');
  assert.deepEqual(legacyCompleted.limitations, [{
    code: 'legacy_quality_unknown',
    message: '该历史任务未经过当前相关性与证据覆盖评估。'
  }]);

  const created = store.create({
    question: '对指定知识库做混合研究',
    searchMode: 'hybrid',
    knowledgeBaseIds: ['kb-project']
  });
  store.claim(created.id);
  store.updateRunning(created.id, {
    stage: 'writing',
    progress: 72,
    webSearchStatus: 'unavailable',
    artifacts: { outline: [{ heading: '结论' }] }
  });
  store.close();

  store = createResearchStore(dbPath);
  const reopened = store.get(created.id);
  assert.equal(reopened.searchMode, 'hybrid');
  assert.equal(reopened.webSearchStatus, 'unavailable');
  assert.equal(reopened.stage, 'writing');
  assert.equal(reopened.attempt, 1);
  assert.deepEqual(reopened.knowledgeBaseIds, ['kb-project']);
  assert.deepEqual(reopened.artifacts, { outline: [{ heading: '结论' }] });
  assert.equal(typeof reopened.startedAt, 'number');
  store.close();
});

test('startup recovery returns every queued or interrupted task without a 100-row cap', () => {
  const dbPath = temporaryDatabasePath();
  let store = createResearchStore(dbPath);
  const tasks = Array.from({ length: 105 }, (_, index) =>
    store.create(`恢复任务 ${index + 1}`)
  );

  for (const task of tasks) {
    store.claim(task.id);
  }
  store.updateRunning(tasks[104].id, {
    stage: 'outlining',
    progress: 60,
    artifacts: { subquestions: ['已完成的规划'] }
  });
  store.close();

  store = createResearchStore(dbPath);
  const resumable = store.resume();
  assert.equal(resumable.length, 105);
  assert.ok(resumable.every((task) => task.status === 'queued'));
  const last = resumable.find((task) => task.id === tasks[104].id);
  assert.equal(last.stage, 'outlining');
  assert.deepEqual(last.artifacts.subquestions, ['已完成的规划']);
  store.close();
});

test('worker resumes an interrupted task from its persisted stage without repeating retrieval', async () => {
  const dbPath = temporaryDatabasePath();
  let store = createResearchStore(dbPath);
  const task = store.create('从中间阶段恢复');
  store.claim(task.id);
  store.updateRunning(task.id, {
    stage: 'outlining',
    progress: 60,
    citations: [{
      id: 'persisted-source',
      index: 1,
      title: '已持久化资料',
      url: '',
      snippet: '这条证据在进程重启前已经提取完成。',
      source: '本地知识库',
      kind: 'local',
      knowledgeBaseId: '',
      documentId: ''
    }],
    artifacts: {
      subquestions: ['从中间阶段恢复'],
      sources: [{
        id: 'persisted-source',
        title: '已持久化资料',
        url: '',
        snippet: '这条证据在进程重启前已经提取完成。',
        source: '本地知识库',
        kind: 'local',
        knowledgeBaseId: '',
        documentId: '',
        queries: ['从中间阶段恢复']
      }],
      citations: [{
        id: 'persisted-source',
        index: 1,
        title: '已持久化资料',
        url: '',
        snippet: '这条证据在进程重启前已经提取完成。',
        source: '本地知识库',
        kind: 'local',
        knowledgeBaseId: '',
        documentId: ''
      }],
      evidence: [{
        citationId: 'persisted-source',
        citationNumber: 1,
        claim: '这条证据在进程重启前已经提取完成。',
        snippet: '这条证据在进程重启前已经提取完成。',
        sourceId: 'persisted-source',
        queries: ['从中间阶段恢复']
      }]
    }
  });
  store.close();

  store = createResearchStore(dbPath);
  let retrievalCalls = 0;
  const worker = createResearchWorker({
    store,
    searchSources: async () => {
      retrievalCalls += 1;
      throw new Error('恢复时不应重复检索');
    }
  });
  await worker.resume();

  const completed = store.get(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt, 2);
  assert.equal(retrievalCalls, 0);
  assert.match(completed.report, /已持久化资料/);
  assert.equal(completed.artifacts.verification.valid, true);
  store.close();
});

test('retry is restricted to failed or cancelled tasks and preserves resumable artifacts', () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create('失败后重试');
  assert.throws(
    () => store.retry(task.id),
    (error) => error.code === 'RESEARCH_INVALID_TRANSITION' && error.status === 409
  );

  store.claim(task.id);
  store.updateRunning(task.id, {
    stage: 'retrieving',
    artifacts: { subquestions: ['已保存的子问题'] }
  });
  const failed = store.fail(task.id, {
    failedStage: 'retrieving',
    error: '检索服务失败'
  });
  assert.equal(failed.stage, 'retrieving');
  assert.equal(failed.failedStage, 'retrieving');

  const retried = store.retry(task.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.stage, 'retrieving');
  assert.equal(retried.failedStage, '');
  assert.deepEqual(retried.artifacts.subquestions, ['已保存的子问题']);
  assert.equal(retried.attempt, 1);
  store.close();
});

test('a completed research run creates an ordered follow-up without mutating the original report', () => {
  const store = createResearchStore(temporaryDatabasePath());
  const root = store.create({
    question: '如何做好 coding agent？',
    searchMode: 'hybrid',
    knowledgeBaseIds: ['kb-agent']
  });
  store.claim(root.id);
  const completed = store.complete(root.id, {
    report: '# 第一轮结论\n需要补充 OpenHands 的实现证据。',
    citations: [{
      id: 'web-openhands',
      title: 'OpenHands',
      snippet: 'An AI-driven software development platform.',
      url: 'https://github.com/All-Hands-AI/OpenHands',
      kind: 'web',
      sourceKind: 'public_web'
    }],
    resultQuality: 'limited',
    limitations: [{ code: 'public_source_provenance_unverified', message: '公开来源尚未核验。' }]
  });

  const followUp = store.continueSession(completed.id, {
    question: '只比较 OpenHands、Aider 与 SWE-agent 的 Agent Loop。'
  });
  const runs = store.listSession(followUp.id);

  assert.equal(followUp.status, 'queued');
  assert.equal(followUp.sessionId, root.id);
  assert.equal(followUp.parentTaskId, root.id);
  assert.equal(followUp.turnIndex, 2);
  assert.equal(followUp.continuationContext.originQuestion, root.question);
  assert.equal(followUp.continuationContext.parent.taskId, root.id);
  assert.equal(followUp.continuationContext.citations[0].originTaskId, root.id);
  assert.equal(store.get(root.id).report, completed.report);
  assert.deepEqual(runs.map((task) => task.turnIndex), [1, 2]);
  assert.throws(
    () => store.continueSession(root.id, { question: '不应并发开始第三轮' }),
    (error) => error.code === 'RESEARCH_SESSION_BUSY'
  );
  store.close();
});

test('a follow-up worker receives bounded prior context for planning but writes only current evidence', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const root = store.create('如何做好 coding agent？');
  store.claim(root.id);
  store.complete(root.id, {
    report: '# 第一轮\n已有项目清单，缺少 Agent Loop 实现细节。',
    citations: [{
      id: 'root-source', title: '项目清单', snippet: '第一轮的来源摘要。',
      url: 'https://example.com/root', kind: 'web', sourceKind: 'public_web'
    }],
    resultQuality: 'limited',
    limitations: [{ code: 'evidence_gap', message: '缺少实现细节。' }]
  });
  const followUp = store.continueSession(root.id, {
    question: '只比较 OpenHands 的 Agent Loop。'
  });
  const plannerInputs = [];
  const writerInputs = [];
  const worker = createResearchWorker({
    store,
    async planResearch(input) {
      plannerInputs.push(input);
      return {
        subquestions: [{
          question: 'OpenHands 的 Agent Loop 如何组织？',
          searchQuery: 'OpenHands Agent Loop',
          intent: 'implementation'
        }]
      };
    },
    async searchSources() {
      return {
        local: [{
          id: 'current-source', title: 'OpenHands loop',
          snippet: 'OpenHands uses an agent loop to invoke tools and observe results.',
          retrieval: { vectorScore: 0.8 }
        }],
        web: [],
        webSearchStatus: 'not_requested'
      };
    },
    async writeResearchReport(input) {
      writerInputs.push(input);
      return '## 结论\n本轮仅基于当前证据。 [1]';
    }
  });

  await worker.enqueue(followUp.id);

  assert.equal(plannerInputs[0].continuationContext.parent.taskId, root.id);
  assert.equal(plannerInputs[0].continuationContext.citations.length, 1);
  assert.equal(writerInputs[0].continuationContext.parent.taskId, root.id);
  assert.equal(writerInputs[0].evidence.length, 1);
  assert.equal(writerInputs[0].evidence[0].sourceId, 'current-source');
  store.close();
});

test('worker creates real stage artifacts, structured citations, and a verified report', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create({
    question: '如何建立可恢复的异步研究流程？',
    searchMode: 'hybrid',
    knowledgeBaseIds: ['kb-architecture']
  });
  const calls = [];
  const worker = createResearchWorker({
    store,
    async searchSources(request) {
      calls.push(request);
      return {
        local: [{
          id: 'local-architecture',
          title: '内部架构说明',
          snippet: '任务需要持久化阶段产物，并在重启后从当前阶段继续。',
          source: '本地知识库',
          knowledgeBaseId: 'kb-architecture',
          retrieval: { vectorScore: 0.76 }
        }],
        web: [{
          id: 'web-abort',
          title: 'AbortController documentation',
          url: 'https://example.test/abort-controller',
          snippet: 'AbortSignal lets an asynchronous operation observe cancellation.',
          source: 'web',
          sourceKind: 'official_docs',
          retrieval: { vectorScore: 0.72 }
        }],
        webSearchStatus: 'available'
      };
    }
  });

  await worker.enqueue(task.id);

  const completed = store.get(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.stage, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.webSearchStatus, 'available');
  assert.equal(completed.artifacts.plan.planner, 'fallback');
  assert.equal(completed.attempt, 1);
  assert.equal(completed.resultQuality, 'limited');
  assert.ok(completed.limitations.some((item) => item.code === 'thin_evidence_pack'));
  assert.equal(calls.length, completed.artifacts.subquestions.length);
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  assert.ok(calls.every((call) => call.knowledgeBaseIds[0] === 'kb-architecture'));
  assert.ok(completed.artifacts.sources.length >= 2);
  assert.ok(completed.artifacts.evidence.length >= 2);
  assert.equal(completed.artifacts.outline.length, completed.artifacts.subquestions.length + 2);
  assert.equal(completed.artifacts.sections.length, completed.artifacts.subquestions.length);
  assert.equal(completed.artifacts.verification.valid, true);
  assert.deepEqual(completed.artifacts.verification.invalidCitationNumbers, []);
  assert.ok(completed.report.includes('# 异步深度研究报告'));
  assert.match(completed.report, /\[1\]/);
  assert.equal(completed.citations[0].index, 1);
  assert.ok(completed.citations.some((citation) => citation.source === 'web'));
  store.close();
});

test('worker persists a bounded model plan and lets the writer see only screened evidence', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create({
    question: '如何让 Vue Agent 的深度研究任务可恢复？',
    searchMode: 'local',
    knowledgeBaseIds: ['kb-agent']
  });
  const retrievedQueries = [];
  const writerInputs = [];
  const worker = createResearchWorker({
    store,
    async planResearch() {
      return {
        subquestions: [
          {
            question: 'Vue Agent 的深度研究任务如何持久化阶段状态？',
            searchQuery: 'Vue Agent 深度研究 阶段持久化',
            intent: 'implementation',
            rationale: '先确认恢复依赖的状态边界。'
          },
          {
            question: 'Vue Agent 的深度研究任务重试时如何避免重复执行？',
            searchQuery: 'Vue Agent 深度研究 重试 重复执行',
            intent: 'risk',
            rationale: '再核对失败恢复的并发风险。'
          }
        ]
      };
    },
    async searchSources({ query }) {
      retrievedQueries.push(query);
      return {
        local: [{
          id: `source-${retrievedQueries.length}`,
          title: 'Vue Agent 深度研究任务恢复',
          snippet: '将每个阶段产物持久化，并使用任务领取锁避免重试时重复执行。',
          source: '项目资料',
          retrieval: { vectorScore: 0.82 }
        }],
        web: [],
        webSearchStatus: 'not_requested'
      };
    },
    async writeResearchReport(input) {
      writerInputs.push(input);
      return '## 结论\n阶段产物持久化与领取锁共同保证可恢复执行。 [1]';
    }
  });

  await worker.enqueue(task.id);
  const completed = store.get(task.id);

  assert.deepEqual(retrievedQueries, [
    'Vue Agent official docs official GitHub implementation',
    'Vue Agent official docs paper risks limitations'
  ]);
  assert.equal(completed.artifacts.plan.planner, 'model');
  assert.equal(completed.artifacts.plan.subquestions.length, 2);
  assert.equal(completed.artifacts.evidencePack.includedCount, 2);
  assert.equal(writerInputs.length, 1);
  assert.equal(writerInputs[0].evidence.length, completed.artifacts.evidencePack.includedCount);
  assert.equal(completed.artifacts.writer.mode, 'model');
  assert.match(completed.report, /领取锁/);
  store.close();
});

test('worker retrieves planned subquestions concurrently but preserves plan order', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create({
    question: '比较 OpenHands 与 Aider 的代码编辑能力',
    searchMode: 'local'
  });
  let started = 0;
  let active = 0;
  let maxActive = 0;
  let releaseSearches;
  const gate = new Promise((resolve) => { releaseSearches = resolve; });
  const completedQueries = [];
  const worker = createResearchWorker({
    store,
    async planResearch() {
      return {
        subquestions: [
          {
            subject: 'OpenHands',
            question: 'OpenHands 如何编辑代码？',
            intent: 'implementation',
            facets: ['code_editing'],
            preferredSourceTypes: ['official_repo']
          },
          {
            subject: 'Aider',
            question: 'Aider 如何编辑代码？',
            intent: 'implementation',
            facets: ['code_editing'],
            preferredSourceTypes: ['official_repo']
          }
        ]
      };
    },
    async searchSources({ query, queryIndex }) {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 2) releaseSearches();
      await gate;
      if (queryIndex === 0) await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      completedQueries.push(query);
      return {
        local: [{
          id: `source-${queryIndex}`,
          title: `${query} 官方资料`,
          snippet: `${query} 提供代码编辑与验证能力。`,
          source: '项目资料',
          retrieval: { vectorScore: 0.9 }
        }],
        web: [],
        webSearchStatus: 'not_requested'
      };
    }
  });

  await worker.enqueue(task.id);
  const completed = store.get(task.id);
  assert.equal(maxActive, 2);
  assert.equal(completed.artifacts.search.diagnostics.length, 2);
  assert.deepEqual(
    completed.artifacts.search.queries.map((item) => item.id),
    ['q1', 'q2']
  );
  assert.notDeepEqual(completedQueries, completed.artifacts.search.queries.map((item) => item.searchQuery));
  store.close();
});

test('an unavailable web provider falls back to local evidence and still completes', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create({ question: '无联网 key 时如何研究？', searchMode: 'web' });
  const worker = createResearchWorker({
    store,
    searchSources: async () => ({
      local: [{
        id: 'fallback-local',
        title: '本地备选资料',
        snippet: '联网不可用时可以继续使用本地知识库。',
        source: '本地知识库',
        retrieval: { vectorScore: 0.68 }
      }],
      web: [],
      webSearchStatus: 'unavailable'
    })
  });

  await worker.enqueue(task.id);
  const completed = store.get(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.webSearchStatus, 'unavailable');
  assert.equal(completed.resultQuality, 'limited');
  assert.equal(completed.limitations[0].code, 'public_search_unavailable');
  assert.equal(completed.citations.length, 1);
  assert.match(completed.report, /本地备选资料/);
  store.close();
});

test('worker records the exact failed stage and retry resumes from persisted artifacts', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create('测试检索失败');
  let shouldFail = true;
  const worker = createResearchWorker({
    store,
    searchSources: async () => {
      if (shouldFail) throw new Error('上游检索超时');
      return [];
    }
  });

  await worker.enqueue(task.id);
  const failed = store.get(task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'retrieving');
  assert.equal(failed.failedStage, 'retrieving');
  assert.match(failed.error, /上游检索超时/);
  assert.ok(failed.artifacts.subquestions.length > 0);

  shouldFail = false;
  await worker.retry(task.id);
  const completed = store.get(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.resultQuality, 'insufficient');
  assert.ok(completed.artifacts.subquestions.length > 0);
  store.close();
});

test('cancellation aborts in-flight retrieval and late results cannot overwrite cancelled state', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create('取消竞态');
  const searchStarted = deferred();
  const searchResult = deferred();
  let observedSignal;
  const worker = createResearchWorker({
    store,
    searchSources: async ({ signal }) => {
      observedSignal = signal;
      searchStarted.resolve();
      return searchResult.promise;
    }
  });

  const running = worker.enqueue(task.id);
  await searchStarted.promise;
  const cancelled = worker.cancel(task.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(observedSignal.aborted, true);

  searchResult.resolve([{
    id: 'late-result',
    title: '迟到的结果',
    snippet: '这条结果不应该完成任务。',
    source: 'web'
  }]);
  await running;

  const finalTask = store.get(task.id);
  assert.equal(finalTask.status, 'cancelled');
  assert.notEqual(finalTask.stage, 'completed');
  assert.equal(finalTask.report, '');
  assert.equal(finalTask.finishedAt, cancelled.finishedAt);
  store.close();
});

test('retry requested before a cancelled run cleans up is queued behind the old run', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const task = store.create('取消后立即重试');
  const searchStarted = deferred();
  const releaseOldSearch = deferred();
  let searchCalls = 0;
  const worker = createResearchWorker({
    store,
    searchSources: async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        searchStarted.resolve();
        await releaseOldSearch.promise;
      }
      return { local: [], web: [], webSearchStatus: 'not_requested' };
    }
  });

  const oldRun = worker.enqueue(task.id);
  await searchStarted.promise;
  worker.cancel(task.id);
  const retriedRun = worker.retry(task.id);
  assert.equal(store.get(task.id).status, 'queued');
  releaseOldSearch.resolve();

  await oldRun;
  const completed = await retriedRun;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt, 2);
  assert.equal(worker.isActive(task.id), false);
  store.close();
});

test('worker uses a single queue and cancellation can remove a task before it starts', async () => {
  const store = createResearchStore(temporaryDatabasePath());
  const first = store.create('第一个研究任务');
  const second = store.create('第二个研究任务');
  const firstSearchStarted = deferred();
  const releaseFirstSearch = deferred();
  const searchedQuestions = [];
  let firstCall = true;
  const worker = createResearchWorker({
    store,
    searchSources: async (request) => {
      searchedQuestions.push(request.question);
      if (firstCall) {
        firstCall = false;
        firstSearchStarted.resolve();
        await releaseFirstSearch.promise;
      }
      return { local: [], web: [], webSearchStatus: 'not_requested' };
    }
  });

  const firstRun = worker.enqueue(first.id);
  const secondRun = worker.enqueue(second.id);
  await firstSearchStarted.promise;
  const cancelled = worker.cancel(second.id);
  assert.equal(cancelled.status, 'cancelled');
  releaseFirstSearch.resolve();
  await Promise.all([firstRun, secondRun]);

  assert.equal(store.get(first.id).status, 'completed');
  assert.equal(store.get(second.id).status, 'cancelled');
  assert.ok(searchedQuestions.every((question) => question === first.question));
  store.close();
});

test('report rendering escapes untrusted markdown and never links unsafe source URLs', () => {
  const verified = verifyResearchReport('证据 [1]', [{
    id: 'local-source',
    index: 1,
    title: 'local.md',
    url: 'javascript:alert(1)',
    snippet: '![tracking](https://tracker.example/pixel)',
    source: '本地知识库'
  }]);

  assert.match(verified.report, /local\\\.md/);
  assert.doesNotMatch(verified.report, /javascript:/);
  assert.doesNotMatch(verified.report, /!\[tracking\]\(/);
  assert.match(verified.report, /!\\\[tracking\\\]\\\(https:\/\/tracker/);
});

test('report verification rejects symbolic pseudo citations that are not in the Evidence Pack', () => {
  const verified = verifyResearchReport('有效证据 [1]，伪造章节引用 [q2]。', [{
    id: 'source-1',
    index: 1,
    title: 'Source',
    snippet: 'Evidence',
    source: 'web'
  }]);
  assert.equal(verified.verification.valid, false);
  assert.deepEqual(verified.verification.invalidCitationMarkers, ['q2']);
  assert.match(verified.report, /无效引用 q2/);
});
