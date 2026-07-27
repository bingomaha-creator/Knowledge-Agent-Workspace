import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeStore } from '../knowledge-store.js';
import { createKnowledgeIndexLifecycle } from './knowledge-index-lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('started lifecycle automatically indexes a queued Store mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-lifecycle-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const scheduled = [];
  const lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    scheduleTask(task) { scheduled.push(task); },
    idFactory: () => 'chunk-lifecycle',
    logger: { error() {} }
  });
  lifecycle.start();
  t.after(async () => {
    await lifecycle.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  store.insertQueuedDocuments([{
    id: 'doc-lifecycle',
    knowledgeBaseId: 'kb-default',
    name: 'lifecycle.md',
    content: '# Lifecycle\n\nautomatic indexing marker',
    createdAt: 1,
    updatedAt: 1
  }]);

  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(store.listDocumentsByStatus(['ready'])[0].id, 'doc-lifecycle');
  assert.equal(store.listDocumentChunks('doc-lifecycle').length, 1);
  assert.equal(store.searchChunksByKeyword('automatic indexing', 5).length, 0);
  store.publishDocument('doc-lifecycle');
  assert.equal(store.searchChunksByKeyword('automatic indexing', 5).length, 1);
});

test('lifecycle start recovers durable queued and interrupted processing work', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-recovery-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const scheduled = [];
  store.insertQueuedDocuments([{
    id: 'doc-before-start',
    knowledgeBaseId: 'kb-default',
    name: 'recovery.md',
    content: '# Recovery\n\ndurable queue marker',
    createdAt: 1,
    updatedAt: 1
  }, {
    id: 'doc-interrupted',
    knowledgeBaseId: 'kb-default',
    name: 'interrupted.md',
    content: '# Recovery\n\ninterrupted processing marker',
    createdAt: 2,
    updatedAt: 2
  }]);
  store.claimDocumentForIndex('doc-interrupted');
  let nextChunkId = 0;
  const lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient: { async embed() { return [1, 0]; } },
    scheduleTask(task) { scheduled.push(task); },
    idFactory: () => `chunk-recovered-${++nextChunkId}`,
    logger: { error() {} }
  });
  t.after(async () => {
    await lifecycle.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  lifecycle.start();
  lifecycle.start();
  assert.equal(scheduled.length, 2);
  while (scheduled.length) await scheduled.shift()();

  assert.deepEqual(
    store.listDocumentsByStatus(['ready']).map((document) => document.id),
    ['doc-before-start', 'doc-interrupted']
  );
  store.publishDocument('doc-before-start');
  store.publishDocument('doc-interrupted');
  assert.equal(store.searchChunksByKeyword('durable queue', 5).length, 1);
  assert.equal(store.searchChunksByKeyword('interrupted processing', 5).length, 1);
});

test('an edit during indexing converges to the newest durable document generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-edit-race-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const project = store.createBugProject({
    projectRef: 'project-edit-race',
    knowledgeBaseId: 'kb-project-edit-race',
    name: 'Edit race'
  });
  const scheduled = [];
  const firstEmbeddingStarted = deferred();
  const releaseFirstEmbedding = deferred();
  const embeddedTexts = [];
  let nextChunkId = 0;
  const lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient: {
      async embed(text) {
        embeddedTexts.push(text);
        if (embeddedTexts.length === 1) {
          firstEmbeddingStarted.resolve();
          await releaseFirstEmbedding.promise;
        }
        return [1, 0];
      }
    },
    scheduleTask(task) { scheduled.push(task); },
    idFactory: () => `chunk-edit-race-${++nextChunkId}`,
    logger: { error() {} }
  });
  lifecycle.start();
  t.after(async () => {
    releaseFirstEmbedding.resolve();
    await lifecycle.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  store.insertBugCaseDocument({
    id: 'bug-edit-race',
    knowledgeBaseId: project.id,
    name: 'edit-race.bug.md',
    content: 'obsolete generation marker',
    metadata: { sourceProjectRef: project.projectRef }
  });
  const firstJob = scheduled.shift()();
  await firstEmbeddingStarted.promise;

  store.updateBugCaseContent('bug-edit-race', {
    name: 'edit-race.bug.md',
    content: 'current generation marker',
    metadata: { sourceProjectRef: project.projectRef },
    updatedAt: 2
  });
  assert.equal(scheduled.length, 1);
  const duplicateWake = scheduled.shift()();
  releaseFirstEmbedding.resolve();
  await Promise.all([firstJob, duplicateWake]);

  assert.equal(embeddedTexts.length, 2);
  assert.match(embeddedTexts[1], /current generation marker/);
  assert.equal(store.getBugCaseDocument('bug-edit-race').status, 'ready');
  store.reviewBugCaseDocument('bug-edit-race', {
    reviewStatus: 'confirmed',
    metadata: { sourceProjectRef: project.projectRef },
    updatedAt: 3
  });
  assert.equal(store.searchChunksByKeyword('current', 5, {
    knowledgeBaseId: project.id
  }).length, 1);
  assert.equal(store.searchChunksByKeyword('obsolete', 5, {
    knowledgeBaseId: project.id
  }).length, 0);
});

test('deleting a document during indexing never resurrects it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-delete-race-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const scheduled = [];
  const embeddingStarted = deferred();
  const releaseEmbedding = deferred();
  const lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient: {
      async embed() {
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
        return [1, 0];
      }
    },
    scheduleTask(task) { scheduled.push(task); },
    idFactory: () => 'chunk-delete-race',
    logger: { error() {} }
  });
  lifecycle.start();
  t.after(async () => {
    releaseEmbedding.resolve();
    await lifecycle.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  store.insertQueuedDocuments([{
    id: 'doc-delete-race',
    knowledgeBaseId: 'kb-default',
    name: 'delete-race.md',
    content: 'must not resurrect marker',
    createdAt: 1,
    updatedAt: 1
  }]);
  const job = scheduled.shift()();
  await embeddingStarted.promise;
  assert.equal(store.deleteDocument('doc-delete-race'), 1);
  releaseEmbedding.resolve();
  await job;

  assert.deepEqual(store.loadState().documents, []);
  assert.deepEqual(store.loadState().chunks, []);
  assert.deepEqual(store.searchChunksByKeyword('resurrect', 5), []);
});
