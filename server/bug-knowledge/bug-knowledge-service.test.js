import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeStore } from '../knowledge-store.js';
import { createKnowledgeIndexLifecycle } from '../services/knowledge-index-lifecycle.js';
import { createKnowledgeService } from '../services/knowledge-service.js';
import { createBugKnowledgeService } from './bug-knowledge-service.js';

function createFixture({ embed } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-agent-bug-service-'));
  const store = createKnowledgeStore(path.join(directory, 'knowledge.sqlite'));
  const scheduled = [];
  let nextId = 0;
  let timestamp = 1_000;
  const embeddingClient = {
    async embed(text) {
      return embed ? embed(text) : [String(text).length / 100, 0.25];
    }
  };
  const createId = (prefix) => {
    nextId += 1;
    return `${prefix}-${nextId}`;
  };
  const knowledgeService = createKnowledgeService({
    store,
    embeddingClient,
    embeddingModel: 'test-embedding',
    idFactory: createId,
    now() {
      timestamp += 1;
      return timestamp;
    },
    logger: { error() {} }
  });
  const lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient,
    scheduleTask(task) {
      scheduled.push(task);
    },
    idFactory: createId,
    logger: { error() {} }
  });
  lifecycle.start();
  const bugKnowledgeService = createBugKnowledgeService({
    store,
    knowledgeRetrieval: knowledgeService,
    idFactory: createId,
    now() {
      timestamp += 1;
      return timestamp;
    }
  });

  return {
    store,
    knowledgeService,
    lifecycle,
    bugKnowledgeService,
    scheduled,
    async runScheduled() {
      while (scheduled.length) await scheduled.shift()();
    }
  };
}

function createBugCaseInput(sourceProjectRef, overrides = {}) {
  return {
    sourceProjectRef,
    title: 'Hydration marker mismatch',
    symptom: '页面出现 hydrationmarker，客户端节点与服务端节点不一致。',
    errorSignatures: ['Hydration node mismatch at /tmp/App.vue:42'],
    reproductionSteps: ['启动 SSR', '刷新详情页'],
    context: {
      language: 'TypeScript',
      framework: 'Vue',
      versions: ['3.5.13'],
      module: 'detail',
      environment: 'Node 22'
    },
    resolutionType: 'root_cause_fix',
    rootCause: '服务端与客户端时区不同。',
    fix: '统一使用 UTC formatter。',
    verification: 'SSR 快照与浏览器 hydration 测试通过。',
    tags: ['ssr'],
    sourceRefs: ['tests/detail.spec.ts'],
    ...overrides
  };
}

test('Bug projects have a server-generated stable projectRef and one system knowledge base', () => {
  const fixture = createFixture();
  const created = fixture.bugKnowledgeService.createProject({
    name: 'Vue storefront',
    description: '前台项目'
  });

  assert.match(created.projectRef, /^project-/);
  assert.match(created.knowledgeBaseId, /^kb-project-/);
  assert.equal(created.kind, 'project_bugs');
  assert.equal(fixture.store.getKnowledgeBase(created.knowledgeBaseId).projectRef, created.projectRef);
  assert.equal(fixture.store.listKnowledgeBases().some((base) => base.id === created.knowledgeBaseId), false);

  const updated = fixture.bugKnowledgeService.updateProject(created.projectRef, {
    name: 'Vue Storefront Web',
    description: '重命名不改变身份'
  });
  assert.equal(updated.projectRef, created.projectRef);
  assert.equal(updated.knowledgeBaseId, created.knowledgeBaseId);
  assert.equal(updated.name, 'Vue Storefront Web');
  assert.deepEqual(
    fixture.bugKnowledgeService.listProjects().map((project) => project.projectRef),
    [created.projectRef]
  );

  fixture.store.close();
});

test('BugCase create, processing, review, rejection, and content edit form one enforced state machine', async () => {
  const fixture = createFixture();
  const project = fixture.bugKnowledgeService.createProject({ name: 'Storefront' });

  assert.throws(
    () => fixture.bugKnowledgeService.createBugCase({
      ...createBugCaseInput(project.projectRef),
      reviewStatus: 'confirmed'
    }),
    (error) => error.code === 'BUG_CASE_UNKNOWN_FIELD' && error.status === 400
  );

  const candidate = fixture.bugKnowledgeService.createBugCase(
    createBugCaseInput(project.projectRef)
  );
  assert.equal(candidate.reviewStatus, 'candidate');
  assert.equal(candidate.status, 'queued');
  assert.equal(candidate.reviewedBy, null);
  assert.deepEqual(fixture.store.listDocuments(), []);
  assert.throws(
    () => fixture.bugKnowledgeService.reviewBugCase(candidate.id, {
      reviewStatus: 'confirmed',
      reviewReason: '尚未处理完成'
    }),
    (error) => error.code === 'BUG_CASE_NOT_READY' && error.status === 409
  );

  await fixture.runScheduled();
  assert.equal(fixture.bugKnowledgeService.getBugCase(candidate.id).status, 'ready');
  assert.deepEqual(fixture.store.searchChunksByKeyword('hydrationmarker', 5), []);

  const confirmed = fixture.bugKnowledgeService.reviewBugCase(candidate.id, {
    reviewStatus: 'confirmed',
    reviewReason: '在最小复现项目中验证通过',
    reviewedBy: 'forged-admin'
  });
  assert.equal(confirmed.reviewStatus, 'confirmed');
  assert.equal(confirmed.reviewedBy, 'local-user');
  assert.equal(confirmed.reviewReason, '在最小复现项目中验证通过');
  assert.equal(typeof confirmed.reviewedAt, 'number');
  assert.deepEqual(
    fixture.store.searchChunksByKeyword('hydrationmarker', 5).map((match) => match.chunkId).length,
    1
  );
  assert.ok((await fixture.knowledgeService.searchKnowledge('hydrationmarker', 5)).citations.length > 0);

  const rejected = fixture.bugKnowledgeService.reviewBugCase(candidate.id, {
    reviewStatus: 'rejected',
    reviewReason: '发现验证环境与记录不一致'
  });
  assert.equal(rejected.reviewStatus, 'rejected');
  assert.deepEqual(fixture.store.searchChunksByKeyword('hydrationmarker', 5), []);
  assert.equal((await fixture.knowledgeService.searchKnowledge('hydrationmarker', 5)).citations.length, 0);
  assert.throws(
    () => fixture.bugKnowledgeService.reviewBugCase(candidate.id, {
      reviewStatus: 'confirmed',
      reviewReason: '试图跳过重新编辑'
    }),
    (error) => error.code === 'BUG_CASE_INVALID_REVIEW_TRANSITION' && error.status === 409
  );

  const edited = fixture.bugKnowledgeService.updateBugCase(candidate.id, {
    symptom: '新内容 newhydrationmarker 已替换旧症状。'
  });
  assert.equal(edited.reviewStatus, 'candidate');
  assert.equal(edited.status, 'queued');
  assert.equal(edited.reviewedBy, null);
  assert.equal(edited.reviewReason, null);
  assert.equal(edited.reviewedAt, null);
  assert.deepEqual(fixture.store.searchChunksByKeyword('hydrationmarker', 5), []);
  await fixture.runScheduled();
  assert.equal(fixture.bugKnowledgeService.getBugCase(candidate.id).status, 'ready');
  assert.deepEqual(fixture.store.searchChunksByKeyword('newhydrationmarker', 5), []);

  fixture.store.close();
});

test('review endpoint rejects a root-cause fix that lacks the accepted shared evidence', async () => {
  const fixture = createFixture();
  const project = fixture.bugKnowledgeService.createProject({ name: 'Evidence contract' });
  const created = fixture.bugKnowledgeService.createBugCase(createBugCaseInput(project.projectRef, {
    context: {},
    errorSignatures: [],
    reproductionSteps: [],
    verification: '',
    sourceRefs: []
  }));
  await fixture.runScheduled();

  assert.throws(
    () => fixture.bugKnowledgeService.reviewBugCase(created.id, {
      reviewStatus: 'confirmed',
      reviewReason: '不完整记录不应进入正式检索'
    }),
    (error) => error.code === 'BUG_CASE_TECHNICAL_CONTEXT_REQUIRED' && error.status === 422
  );
  assert.equal(fixture.bugKnowledgeService.getBugCase(created.id).reviewStatus, 'candidate');
  fixture.store.close();
});

test('promoting a confirmed case moves the same document and index into the common scope', async () => {
  const fixture = createFixture();
  const project = fixture.bugKnowledgeService.createProject({ name: 'Admin' });
  const created = fixture.bugKnowledgeService.createBugCase(
    createBugCaseInput(project.projectRef, { symptom: 'promotionmarker 可复现。' })
  );
  await fixture.runScheduled();
  fixture.bugKnowledgeService.reviewBugCase(created.id, {
    reviewStatus: 'confirmed',
    reviewReason: '回归测试通过'
  });

  const promoted = fixture.bugKnowledgeService.promoteBugCase(created.id);
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.sourceProjectRef, project.projectRef);
  assert.equal(promoted.scope, 'common');
  assert.deepEqual(
    fixture.store.searchChunksByKeyword('promotionmarker', 5, project.knowledgeBaseId),
    []
  );
  assert.equal(
    fixture.store.searchChunksByKeyword('promotionmarker', 5, promoted.knowledgeBaseId).length,
    1
  );

  fixture.store.close();
});

test('a failed rebuild after editing cannot expose the old confirmed citation', async () => {
  let failEmbedding = false;
  const fixture = createFixture({
    embed(text) {
      if (failEmbedding) throw new Error('injected embedding failure');
      return [String(text).length / 100, 0.25];
    }
  });
  const project = fixture.bugKnowledgeService.createProject({ name: 'Failure project' });
  const created = fixture.bugKnowledgeService.createBugCase(
    createBugCaseInput(project.projectRef, { symptom: 'oldcitationmarker 可复现。' })
  );
  await fixture.runScheduled();
  fixture.bugKnowledgeService.reviewBugCase(created.id, {
    reviewStatus: 'confirmed',
    reviewReason: '初次验证通过'
  });
  assert.equal(fixture.store.searchChunksByKeyword('oldcitationmarker', 5).length, 1);

  failEmbedding = true;
  fixture.bugKnowledgeService.updateBugCase(created.id, {
    symptom: 'newfailedmarker 将触发索引失败。'
  });
  assert.deepEqual(fixture.store.searchChunksByKeyword('oldcitationmarker', 5), []);
  await fixture.runScheduled();
  const failed = fixture.bugKnowledgeService.getBugCase(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reviewStatus, 'candidate');
  assert.deepEqual(fixture.store.searchChunksByKeyword('oldcitationmarker', 5), []);
  assert.deepEqual(fixture.store.searchChunksByKeyword('newfailedmarker', 5), []);
  fixture.store.close();
});

test('Bug search defaults to current project plus common and only adds private projects explicitly', async () => {
  const fixture = createFixture();
  const currentProject = fixture.bugKnowledgeService.createProject({ name: 'Current' });
  const otherProject = fixture.bugKnowledgeService.createProject({ name: 'Other' });
  const current = fixture.bugKnowledgeService.createBugCase(createBugCaseInput(
    currentProject.projectRef,
    {
      title: 'Current scope case',
      symptom: 'sharedscopemarker current project',
      errorSignatures: ['ScopeError: current failure']
    }
  ));
  const common = fixture.bugKnowledgeService.createBugCase(createBugCaseInput(
    otherProject.projectRef,
    {
      title: 'Common scope case',
      symptom: 'sharedscopemarker common case',
      errorSignatures: ['CommonScopeError: shared failure']
    }
  ));
  const privateOther = fixture.bugKnowledgeService.createBugCase(createBugCaseInput(
    otherProject.projectRef,
    {
      title: 'Private other case',
      symptom: 'sharedscopemarker private other project',
      errorSignatures: ['PrivateScopeError: shared failure']
    }
  ));
  const candidateNoise = fixture.bugKnowledgeService.createBugCase(createBugCaseInput(
    currentProject.projectRef,
    {
      title: 'Candidate noise',
      symptom: 'sharedscopemarker candidate must never return',
      errorSignatures: ['ScopeError: current failure']
    }
  ));
  await fixture.runScheduled();
  for (const id of [current.id, common.id, privateOther.id]) {
    fixture.bugKnowledgeService.reviewBugCase(id, {
      reviewStatus: 'confirmed',
      reviewReason: 'fixture verified'
    });
  }
  fixture.bugKnowledgeService.promoteBugCase(common.id);

  const defaults = await fixture.bugKnowledgeService.searchBugCases({
    query: 'ScopeError: current failure',
    projectRef: currentProject.projectRef,
    includeCommon: true,
    additionalProjectRefs: [],
    topK: 5
  });
  assert.equal(defaults.results[0].bugCase.id, current.id);
  assert.equal(defaults.results.some(({ bugCase }) => bugCase.id === candidateNoise.id), false);
  assert.equal(defaults.results.some(({ bugCase }) => bugCase.id === privateOther.id), false);
  assert.deepEqual(defaults.scope.projectRefs, [currentProject.projectRef]);
  assert.equal(defaults.scope.includesCommon, true);

  const expanded = await fixture.bugKnowledgeService.searchBugCases({
    query: 'sharedscopemarker',
    projectRef: currentProject.projectRef,
    includeCommon: true,
    additionalProjectRefs: [otherProject.projectRef],
    topK: 10
  });
  assert.equal(expanded.results.some(({ bugCase }) => bugCase.id === privateOther.id), true);
  assert.equal(expanded.results.some(({ bugCase }) => bugCase.id === candidateNoise.id), false);
  assert.deepEqual(
    expanded.scope.projectRefs,
    [currentProject.projectRef, otherProject.projectRef]
  );
  await assert.rejects(
    fixture.bugKnowledgeService.searchBugCases({
      query: 'sharedscopemarker',
      projectRef: currentProject.projectRef,
      topK: 21
    }),
    (error) => error.code === 'BUG_SEARCH_INVALID_TOP_K' && error.status === 422
  );
  fixture.store.close();
});
