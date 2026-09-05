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

test('readPublishedDocument paginates ready+published generic documents with stable offsets', async (t) => {
  const fixture = createFixture(t);
  const longContent = '甲'.repeat(15000) + '乙'.repeat(3000);
  const [document] = await fixture.service.ingestDocuments([{ name: 'long.md', content: longContent }]);
  const task = fixture.scheduled.shift()();
  await task;
  fixture.service.publishDocument(document.id, 'kb-default');

  const first = fixture.service.readPublishedDocument(document.id, { knowledgeBaseIds: ['kb-default'] });
  assert.deepEqual(first.document, { id: document.id, name: 'long.md', knowledgeBaseId: 'kb-default' });
  assert.equal(first.totalCharacters, 18000);
  assert.equal(first.offset, 0);
  assert.equal(first.returnedCharacters, 12000);
  assert.equal(first.content, longContent.slice(0, 12000));
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 12000);

  const second = fixture.service.readPublishedDocument(document.id, {
    knowledgeBaseIds: ['kb-default'],
    offset: 12000,
    limit: 3000
  });
  assert.equal(second.content, longContent.slice(12000, 15000));
  assert.equal(second.returnedCharacters, 3000);
  assert.equal(second.truncated, true);
  assert.equal(second.nextOffset, 15000);

  const capped = fixture.service.readPublishedDocument(document.id, {
    knowledgeBaseIds: ['kb-default'],
    offset: 17000,
    limit: 99999
  });
  assert.equal(capped.returnedCharacters, 1000);
  assert.equal(capped.truncated, false);
  assert.equal(capped.nextOffset, null);

  const tail = fixture.service.readPublishedDocument(document.id, {
    knowledgeBaseIds: ['kb-default'],
    offset: 99999
  });
  assert.equal(tail.content, '');
  assert.equal(tail.returnedCharacters, 0);
  assert.equal(tail.truncated, false);
  assert.equal(tail.nextOffset, null);
});

test('readPublishedDocument refuses out-of-scope and non-published documents with a uniform 404', async (t) => {
  function assertDocumentNotFound(action) {
    assert.throws(action, (error) => error.code === 'DOCUMENT_NOT_FOUND' && error.status === 404);
  }

  // queued：已上传但尚未处理
  const queuedFixture = createFixture(t);
  const [queued] = await queuedFixture.service.ingestDocuments([{ name: 'queued.md', content: '排队内容' }]);
  assertDocumentNotFound(() => queuedFixture.service.readPublishedDocument(queued.id, { knowledgeBaseIds: ['kb-default'] }));

  // processing：已启动索引但未完成
  let releaseProcessing;
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
  let embedEntered;
  const processingStarted = new Promise((resolve) => { embedEntered = resolve; });
  const processingFixture = createFixture(t, {
    embeddingClient: {
      async embed() {
        embedEntered();
        await processingGate;
        return [1, 0];
      }
    }
  });
  const [processing] = await processingFixture.service.ingestDocuments([{ name: 'processing.md', content: '处理中内容' }]);
  const processingTask = processingFixture.scheduled.shift()();
  await processingStarted;
  assert.equal(
    processingFixture.service.listDocuments().find((doc) => doc.id === processing.id).status,
    'processing'
  );
  assertDocumentNotFound(() => processingFixture.service.readPublishedDocument(processing.id, { knowledgeBaseIds: ['kb-default'] }));
  releaseProcessing();
  await processingTask;

  // failed：索引失败
  const failedFixture = createFixture(t, {
    embeddingClient: {
      async embed() { throw new Error('boom'); }
    }
  });
  const [failed] = await failedFixture.service.ingestDocuments([{ name: 'failed.md', content: '失败内容' }]);
  await failedFixture.scheduled.shift()();
  assertDocumentNotFound(() => failedFixture.service.readPublishedDocument(failed.id, { knowledgeBaseIds: ['kb-default'] }));

  // ready + draft：处理完成但未发布；发布后可读；撤回后再次不可读
  const draftFixture = createFixture(t);
  const [draft] = await draftFixture.service.ingestDocuments([{ name: 'draft.md', content: '草稿正文' }]);
  await draftFixture.scheduled.shift()();
  assertDocumentNotFound(() => draftFixture.service.readPublishedDocument(draft.id, { knowledgeBaseIds: ['kb-default'] }));
  draftFixture.service.publishDocument(draft.id, 'kb-default');
  const published = draftFixture.service.readPublishedDocument(draft.id, { knowledgeBaseIds: ['kb-default'] });
  assert.equal(published.content, '草稿正文');
  draftFixture.service.withdrawDocument(draft.id, 'kb-default');
  assertDocumentNotFound(() => draftFixture.service.readPublishedDocument(draft.id, { knowledgeBaseIds: ['kb-default'] }));

  // 范围外与空范围
  const scopedFixture = createFixture(t);
  const [scoped] = await scopedFixture.service.ingestDocuments([{ name: 'scoped.md', content: '范围内正文' }]);
  await scopedFixture.scheduled.shift()();
  scopedFixture.service.publishDocument(scoped.id, 'kb-default');
  assertDocumentNotFound(() => scopedFixture.service.readPublishedDocument(scoped.id, { knowledgeBaseIds: ['kb-other'] }));
  assertDocumentNotFound(() => scopedFixture.service.readPublishedDocument(scoped.id, { knowledgeBaseIds: [] }));
  assertDocumentNotFound(() => scopedFixture.service.readPublishedDocument('doc-missing', { knowledgeBaseIds: ['kb-default'] }));

  // 安全边界不把缺失字段当作 generic + ready。
  const getDocument = scopedFixture.store.getDocument;
  scopedFixture.store.getDocument = () => ({
    ...getDocument.call(scopedFixture.store, scoped.id),
    documentType: undefined,
    status: undefined,
    publicationStatus: 'published'
  });
  assertDocumentNotFound(() => scopedFixture.service.readPublishedDocument(scoped.id, { knowledgeBaseIds: ['kb-default'] }));
});
