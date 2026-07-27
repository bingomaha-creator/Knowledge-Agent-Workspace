import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeStore } from '../knowledge-store.js';
import { createKnowledgeIndexLifecycle } from './knowledge-index-lifecycle.js';
import { createKnowledgeService } from './knowledge-service.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-knowledge-service-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  let lifecycle;
  t.after(async () => {
    await lifecycle?.dispose();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scheduled = [];
  const embeddingClient = options.embeddingClient || { async embed() { return [1, 0]; } };
  let nextId = 0;
  const createId = (prefix) => `${prefix}-${++nextId}`;
  const service = createKnowledgeService({
    store,
    embeddingClient,
    embeddingModel: 'test-embedding',
    idFactory: createId,
    logger: { error() {} }
  });
  lifecycle = createKnowledgeIndexLifecycle({
    store,
    embeddingClient,
    scheduleTask(task) {
      scheduled.push(task);
    },
    idFactory: createId,
    logger: { error() {} }
  });
  lifecycle.start();
  return { store, service, lifecycle, scheduled };
}

test('knowledge upload persists queued documents before lifecycle processing', async (t) => {
  const started = deferred();
  const release = deferred();
  let embeddingCalls = 0;
  const fixture = createFixture(t, {
    embeddingClient: {
      async embed() {
        embeddingCalls += 1;
        started.resolve();
        await release.promise;
        return [1, 0];
      }
    }
  });

  const [document] = await fixture.service.ingestDocuments([
    { name: 'guide.md', content: '# Guide\n\nCancellation boundary.' }
  ]);
  assert.equal(document.status, 'queued');
  assert.equal(document.publicationStatus, 'draft');
  assert.deepEqual(
    fixture.service.listKnowledgeBases().map((base) => ({
      id: base.id,
      documentCount: base.documentCount,
      publishedDocumentCount: base.publishedDocumentCount,
      draftDocumentCount: base.draftDocumentCount
    })),
    [{
      id: 'kb-default',
      documentCount: 1,
      publishedDocumentCount: 0,
      draftDocumentCount: 1
    }]
  );
  assert.equal(fixture.store.loadState().documents[0].status, 'queued');
  assert.equal(fixture.scheduled.length, 1);

  const first = fixture.scheduled.shift()();
  await started.promise;
  release.resolve();
  await first;

  assert.equal(embeddingCalls, 1);
  assert.equal(fixture.service.listDocuments()[0].status, 'ready');
  assert.equal(fixture.store.listDocumentChunks(document.id).length, 1);
  assert.equal(fixture.store.loadState().chunks.length, 0);

  const preview = fixture.service.getDocumentPreview(document.id, 'kb-default');
  assert.equal(preview.preview.chunkCount, 1);
  assert.match(preview.preview.excerpt, /Cancellation boundary/);
  const published = fixture.service.publishDocument(document.id, 'kb-default');
  assert.equal(published.publicationStatus, 'published');
  assert.equal(fixture.store.loadState().chunks.length, 1);
  assert.equal(fixture.service.listKnowledgeBases()[0].publishedDocumentCount, 1);
  const withdrawn = fixture.service.withdrawDocument(document.id, 'kb-default');
  assert.equal(withdrawn.publicationStatus, 'draft');
  assert.equal(fixture.store.loadState().chunks.length, 0);
  assert.equal(fixture.store.listDocumentChunks(document.id).length, 1);
});

test('knowledge service converges an atomic index completion failure to failed', async (t) => {
  const fixture = createFixture(t);
  const [document] = await fixture.service.ingestDocuments([
    { name: 'guide.txt', content: 'new content' }
  ]);
  fixture.store.replaceDocumentChunks(document.id, [{
    id: 'chunk-old',
    documentId: document.id,
    knowledgeBaseId: 'kb-default',
    documentName: document.name,
    text: 'old stable content',
    headingPath: [],
    kind: 'plain-text',
    chunkIndex: 0,
    tokens: ['old'],
    embedding: [0, 1]
  }]);
  const complete = fixture.store.completeDocumentIndex;
  fixture.store.completeDocumentIndex = () => {
    throw new Error('simulated replacement failure');
  };

  await fixture.scheduled.shift()();
  fixture.store.completeDocumentIndex = complete;

  const state = fixture.store.loadState();
  assert.equal(state.documents[0].status, 'failed');
  // failed 草稿不会进入检索缓存，但旧的预索引仍在 SQLite 中。
  assert.deepEqual(
    fixture.store.listDocumentChunks(document.id).map((chunk) => chunk.id),
    ['chunk-old']
  );
});

test('knowledge service reads newly committed SQLite state without a manual refresh', async (t) => {
  const fixture = createFixture(t, {
    embeddingClient: { async embed() { return [1, 0]; } }
  });
  fixture.store.insertDocumentsWithChunks(
    [{
      id: 'doc-alpha',
      name: 'alpha.md',
      content: 'alpha failure',
      createdAt: 1000
    }],
    [{
      id: 'chunk-alpha',
      documentId: 'doc-alpha',
      documentName: 'alpha.md',
      text: 'alpha failure marker',
      headingPath: [],
      kind: 'plain-text',
      chunkIndex: 0,
      tokens: ['alpha', 'failure', 'marker'],
      embedding: [1, 0]
    }]
  );
  const channels = await fixture.service.retrieveChunkCandidates(
    'alpha failure',
    10,
    ['kb-default']
  );
  assert.deepEqual(channels.keyword.map((match) => match.documentId), ['doc-alpha']);
  assert.deepEqual(channels.vector.map((match) => match.documentId), ['doc-alpha']);
  assert.equal(channels.keyword[0].chunk.id, 'chunk-alpha');
  assert.deepEqual(channels.degradedChannels, []);
});
