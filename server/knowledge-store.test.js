import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  COMMON_BUG_KNOWLEDGE_BASE_ID,
  createKnowledgeStore,
  DEFAULT_KNOWLEDGE_BASE_ID
} from './knowledge-store.js';

function createTempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-agent-knowledge-'));
  return path.join(directory, 'knowledge.sqlite');
}

function createDocument(id, knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID, overrides = {}) {
  return {
    id,
    name: `${id}.md`,
    content: `# ${id}\n${id} content`,
    createdAt: 1000,
    knowledgeBaseId,
    ...overrides
  };
}

function createChunk(id, documentId, text, overrides = {}) {
  return {
    id,
    documentId,
    documentName: `${documentId}.md`,
    headingPath: [documentId],
    text,
    tokens: text.toLowerCase().split(/\s+/),
    embedding: [0.1, 0.2],
    kind: 'markdown-section',
    chunkIndex: 0,
    ...overrides
  };
}

test('knowledge store persists documents and chunks across store instances', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  store.insertDocumentsWithChunks(
    [
      {
        id: 'doc-1',
        name: 'guide.md',
        content: '# Guide\nRAG content',
        createdAt: 1000
      }
    ],
    [
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentName: 'guide.md',
        headingPath: ['Guide'],
        text: '# Guide\n\nRAG content',
        tokens: ['guide', 'rag'],
        embedding: [0.1, 0.2, 0.3],
        kind: 'markdown-section',
        chunkIndex: 0
      }
    ]
  );
  store.close();

  const reopened = createKnowledgeStore(dbPath);
  const state = reopened.loadState();

  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].name, 'guide.md');
  assert.equal(state.chunks.length, 1);
  assert.deepEqual(state.chunks[0].headingPath, ['Guide']);
  assert.deepEqual(state.chunks[0].embedding, [0.1, 0.2, 0.3]);

  reopened.close();
});

test('knowledge store persists index metadata across store instances', () => {
  const databasePath = createTempDbPath();
  const first = createKnowledgeStore(databasePath);
  first.setMetadata('embedding_model', 'model-a');
  first.close();

  const second = createKnowledgeStore(databasePath);
  assert.equal(second.getMetadata('embedding_model'), 'model-a');
  second.close();
});

test('knowledge store searches chunks through the FTS5 keyword index', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  store.insertDocumentsWithChunks(
    [
      { id: 'doc-1', name: 'rag.md', content: 'content', createdAt: 1000 },
      { id: 'doc-2', name: 'voice.md', content: 'content', createdAt: 1001 }
    ],
    [
      {
        id: 'chunk-rag',
        documentId: 'doc-1',
        documentName: 'rag.md',
        headingPath: ['知识库'],
        text: '知识库通过 SQLite 持久化保存 documents 和 chunks。',
        tokens: ['知识库', 'sqlite', '持久化', '保存', 'documents', 'chunks'],
        embedding: [0.1],
        kind: 'markdown-section',
        chunkIndex: 0
      },
      {
        id: 'chunk-voice',
        documentId: 'doc-2',
        documentName: 'voice.md',
        headingPath: ['语音输入'],
        text: '语音输入使用 Web Speech API。',
        tokens: ['语音输入', 'web', 'speech', 'api'],
        embedding: [0.2],
        kind: 'markdown-section',
        chunkIndex: 0
      }
    ]
  );

  const matches = store.searchChunksByKeyword('知识库持久化', 5);

  assert.equal(matches[0].chunkId, 'chunk-rag');
  assert.equal(matches[0].rank, 1);
  assert.equal(typeof matches[0].bm25Score, 'number');
  assert.ok(matches.every((match) => match.chunkId !== 'chunk-voice'));

  store.close();
});

test('knowledge store removes deleted chunks from the FTS5 keyword index', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  store.insertDocumentsWithChunks(
    [{ id: 'doc-1', name: 'rag.md', content: 'content', createdAt: 1000 }],
    [
      {
        id: 'chunk-rag',
        documentId: 'doc-1',
        documentName: 'rag.md',
        headingPath: ['知识库'],
        text: '知识库通过 SQLite 持久化保存 documents 和 chunks。',
        tokens: ['知识库', 'sqlite', '持久化', '保存', 'documents', 'chunks'],
        embedding: [0.1],
        kind: 'markdown-section',
        chunkIndex: 0
      }
    ]
  );

  assert.equal(store.searchChunksByKeyword('知识库持久化', 5).length, 1);

  store.deleteDocument('doc-1');

  assert.equal(store.searchChunksByKeyword('知识库持久化', 5).length, 0);

  store.close();
});

test('knowledge store deletes a document and its chunks', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  store.insertDocumentsWithChunks(
    [{ id: 'doc-1', name: 'guide.md', content: 'content', createdAt: 1000 }],
    [
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentName: 'guide.md',
        headingPath: [],
        text: 'content',
        tokens: ['content'],
        embedding: [0.1],
        kind: 'plain-text',
        chunkIndex: 0
      }
    ]
  );

  const changes = store.deleteDocument('doc-1');
  const state = store.loadState();

  assert.equal(changes, 1);
  assert.equal(state.documents.length, 0);
  assert.equal(state.chunks.length, 0);

  store.close();
});

test('knowledge store clears all documents and chunks', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  store.insertDocumentsWithChunks(
    [{ id: 'doc-1', name: 'guide.md', content: 'content', createdAt: 1000 }],
    [
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        documentName: 'guide.md',
        headingPath: [],
        text: 'content',
        tokens: ['content'],
        embedding: [0.1],
        kind: 'plain-text',
        chunkIndex: 0
      }
    ]
  );

  store.clearDocuments();
  const state = store.loadState();

  assert.equal(state.documents.length, 0);
  assert.equal(state.chunks.length, 0);

  store.close();
});

test('knowledge store creates a stable default knowledge base and supports CRUD', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);

  const initialBases = store.listKnowledgeBases();
  assert.equal(initialBases.length, 1);
  assert.equal(initialBases[0].id, DEFAULT_KNOWLEDGE_BASE_ID);
  assert.equal(initialBases[0].isDefault, true);

  const created = store.createKnowledgeBase({
    id: 'kb-engineering',
    name: 'Engineering',
    description: 'Technical notes'
  });
  assert.deepEqual(
    { id: created.id, name: created.name, description: created.description, isDefault: created.isDefault },
    { id: 'kb-engineering', name: 'Engineering', description: 'Technical notes', isDefault: false }
  );

  const updated = store.updateKnowledgeBase('kb-engineering', {
    name: 'Product Engineering',
    description: 'Updated notes'
  });
  assert.equal(updated.name, 'Product Engineering');
  assert.equal(updated.description, 'Updated notes');
  assert.equal(store.getKnowledgeBase('kb-engineering').name, 'Product Engineering');
  assert.equal(store.getKnowledgeBase('missing'), null);
  assert.throws(
    () => store.deleteKnowledgeBase(DEFAULT_KNOWLEDGE_BASE_ID),
    /cannot be deleted/
  );

  assert.deepEqual(store.deleteKnowledgeBase('kb-engineering'), {
    ok: true,
    id: 'kb-engineering',
    deletedDocuments: 0
  });
  assert.throws(
    () => store.deleteKnowledgeBase('kb-engineering'),
    (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND' && error.status === 404
  );
  assert.deepEqual(store.listKnowledgeBases().map((base) => base.id), [DEFAULT_KNOWLEDGE_BASE_ID]);
  store.close();

  const reopened = createKnowledgeStore(dbPath);
  assert.equal(reopened.getKnowledgeBase(DEFAULT_KNOWLEDGE_BASE_ID).isDefault, true);
  reopened.close();
});

test('knowledge store scopes state, keyword search, deletion, and clear by knowledge base', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);
  store.createKnowledgeBase({ id: 'kb-a', name: 'A' });
  store.createKnowledgeBase({ id: 'kb-b', name: 'B' });

  store.insertDocumentsWithChunks(
    [createDocument('doc-a', 'kb-a'), createDocument('doc-b', 'kb-b', { createdAt: 1001 })],
    [
      createChunk('chunk-a', 'doc-a', 'sharedterm alpha'),
      createChunk('chunk-b', 'doc-b', 'sharedterm beta')
    ]
  );

  assert.deepEqual(store.loadState('kb-a').documents.map((document) => document.id), ['doc-a']);
  assert.deepEqual(store.loadState({ knowledgeBaseIds: ['kb-b'] }).chunks.map((chunk) => chunk.id), ['chunk-b']);
  assert.deepEqual(
    store.searchChunksByKeyword('sharedterm', 10, ['kb-a']).map((match) => match.chunkId),
    ['chunk-a']
  );
  assert.deepEqual(
    new Set(store.searchChunksByKeyword('sharedterm', 10).map((match) => match.chunkId)),
    new Set(['chunk-a', 'chunk-b'])
  );
  assert.deepEqual(store.searchChunksByKeyword('sharedterm', 10, []).map((match) => match.chunkId), []);

  assert.equal(store.deleteDocument('doc-a', { knowledgeBaseId: 'kb-b' }), 0);
  assert.equal(store.deleteDocument('doc-a', { knowledgeBaseId: 'kb-a' }), 1);
  assert.equal(store.searchChunksByKeyword('alpha', 10).length, 0);

  assert.equal(store.clearDocuments({ knowledgeBaseIds: ['kb-b'] }), 1);
  assert.deepEqual(store.loadState().documents, []);
  assert.deepEqual(store.searchChunksByKeyword('beta', 10), []);
  store.close();
});

test('queued drafts are pre-indexed but only published ready documents are retrievable', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);
  store.createKnowledgeBase({ id: 'kb-jobs', name: 'Jobs' });

  const [queued] = store.insertQueuedDocuments([
    createDocument('doc-job', 'kb-jobs', { createdAt: 2000 })
  ]);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.publicationStatus, 'draft');
  assert.equal(queued.publishedAt, null);
  assert.throws(
    () => store.publishDocument('doc-job'),
    (error) => error.code === 'DOCUMENT_NOT_READY' && error.status === 409
  );
  assert.equal(queued.error, null);
  assert.deepEqual(store.listDocumentsByStatus(['queued']).map((document) => document.id), ['doc-job']);

  const processing = store.claimDocumentForIndex('doc-job');
  assert.equal(processing.status, 'processing');
  const ready = store.completeDocumentIndex('doc-job', [
    createChunk('chunk-job', 'doc-job', 'background worker research')
  ]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.error, null);
  assert.deepEqual(store.listDocumentChunks('doc-job').map((chunk) => chunk.id), ['chunk-job']);
  assert.deepEqual(store.loadState('kb-jobs').chunks, []);
  assert.deepEqual(store.searchChunksByKeyword('background worker', 10, 'kb-jobs'), []);

  const published = store.publishDocument('doc-job', 3000);
  assert.equal(published.publicationStatus, 'published');
  assert.equal(published.publishedAt, 3000);
  assert.deepEqual(store.loadState('kb-jobs').chunks.map((chunk) => chunk.id), ['chunk-job']);
  assert.deepEqual(
    store.searchChunksByKeyword('background worker', 10, 'kb-jobs').map((match) => match.chunkId),
    ['chunk-job']
  );

  const withdrawn = store.withdrawDocument('doc-job', 4000);
  assert.equal(withdrawn.publicationStatus, 'draft');
  assert.equal(withdrawn.publishedAt, null);
  assert.deepEqual(store.loadState('kb-jobs').chunks, []);
  assert.deepEqual(store.listDocumentChunks('doc-job').map((chunk) => chunk.id), ['chunk-job']);
  assert.deepEqual(store.searchChunksByKeyword('background worker', 10, 'kb-jobs'), []);

  store.updateDocumentStatus('doc-job', 'queued');
  store.claimDocumentForIndex('doc-job');
  const failed = store.failDocumentIndex('doc-job', new Error('PDF parser crashed'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'PDF parser crashed');
  assert.deepEqual(store.loadState('kb-jobs').chunks, []);
  assert.deepEqual(store.searchChunksByKeyword('background worker', 10, 'kb-jobs'), []);
  assert.throws(() => store.updateDocumentStatus('doc-job', 'unknown'), /Invalid document status/);
  store.close();

  const reopened = createKnowledgeStore(dbPath);
  const [persisted] = reopened.listDocumentsByStatus(['failed'], { knowledgeBaseId: 'kb-jobs' });
  assert.equal(persisted.error, 'PDF parser crashed');
  assert.equal(reopened.updateDocumentStatus('missing', 'ready'), null);
  reopened.close();
});

test('replacing document chunks is transactional and keeps the previous index on failure', () => {
  const store = createKnowledgeStore(createTempDbPath());
  store.insertDocumentsWithChunks(
    [createDocument('doc-1')],
    [createChunk('chunk-old', 'doc-1', 'old searchable phrase')]
  );

  assert.throws(
    () => store.replaceDocumentChunks('doc-1', [
      createChunk('chunk-new', 'doc-1', 'newonly phrase'),
      createChunk('chunk-new', 'doc-1', 'duplicate id')
    ]),
    /UNIQUE constraint failed/
  );

  assert.deepEqual(
    store.searchChunksByKeyword('old searchable', 10).map((match) => match.chunkId),
    ['chunk-old']
  );
  assert.deepEqual(store.searchChunksByKeyword('newonly', 10), []);
  store.close();
});

test('deleting a knowledge base transactionally removes its documents, chunks, and FTS rows', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);
  store.createKnowledgeBase({ id: 'kb-delete', name: 'Delete me' });
  store.insertDocumentsWithChunks(
    [createDocument('doc-delete', 'kb-delete')],
    [createChunk('chunk-delete', 'doc-delete', 'cascade marker')]
  );

  assert.throws(
    () => store.deleteKnowledgeBase('kb-delete'),
    (error) => error.code === 'KNOWLEDGE_BASE_NOT_EMPTY' && error.status === 409
  );
  assert.deepEqual(store.deleteKnowledgeBase('kb-delete', { force: true }), {
    ok: true,
    id: 'kb-delete',
    deletedDocuments: 1
  });
  assert.equal(store.getKnowledgeBase('kb-delete'), null);
  assert.deepEqual(store.listDocuments('kb-delete'), []);
  assert.deepEqual(store.searchChunksByKeyword('cascade marker', 10), []);
  store.close();

  const database = new DatabaseSync(dbPath);
  assert.equal(database.prepare("SELECT count(*) AS count FROM documents WHERE knowledge_base_id = 'kb-delete'").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM chunks WHERE knowledge_base_id = 'kb-delete'").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM chunks_fts WHERE knowledge_base_id = 'kb-delete'").get().count, 0);
  database.close();
});

test('v1 databases migrate in place to the default ready workspace without losing data', () => {
  const dbPath = createTempDbPath();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      document_name TEXT NOT NULL,
      heading_path_json TEXT NOT NULL,
      text TEXT NOT NULL,
      tokens_json TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      search_text,
      tokenize = 'unicode61'
    );
    CREATE TABLE knowledge_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO documents (id, name, content, created_at)
      VALUES ('legacy-doc', 'legacy.md', 'legacy content', 1234);
    INSERT INTO chunks (
      id, document_id, document_name, heading_path_json, text,
      tokens_json, embedding_json, kind, chunk_index, created_at
    ) VALUES (
      'legacy-chunk', 'legacy-doc', 'legacy.md', '["Legacy"]',
      'legacy migration marker', '["legacy","migration","marker"]', '[0.5]',
      'markdown-section', 0, 1234
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = createKnowledgeStore(dbPath);
  const state = store.loadState();
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].knowledgeBaseId, DEFAULT_KNOWLEDGE_BASE_ID);
  assert.equal(state.documents[0].status, 'ready');
  assert.equal(state.documents[0].error, null);
  assert.equal(state.documents[0].updatedAt, 1234);
  assert.equal(state.documents[0].publicationStatus, 'published');
  assert.equal(state.documents[0].publishedAt, 1234);
  assert.equal(state.chunks[0].knowledgeBaseId, DEFAULT_KNOWLEDGE_BASE_ID);
  assert.deepEqual(
    store.searchChunksByKeyword('migration marker', 10, DEFAULT_KNOWLEDGE_BASE_ID).map((match) => match.chunkId),
    ['legacy-chunk']
  );
  store.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4);
  assert.ok(migrated.prepare('PRAGMA table_info(documents)').all().some((column) => column.name === 'status'));
  assert.ok(migrated.prepare('PRAGMA table_info(documents)').all().some((column) => column.name === 'document_type'));
  assert.ok(migrated.prepare('PRAGMA table_info(documents)').all().some((column) => column.name === 'publication_status'));
  assert.ok(migrated.prepare('PRAGMA table_info(chunks_fts)').all().some((column) => column.name === 'knowledge_base_id'));
  migrated.close();
});

test('v2 databases migrate additively and keep legacy rows generic plus confirmed', () => {
  const dbPath = createTempDbPath();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      document_name TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL,
      heading_path_json TEXT NOT NULL,
      text TEXT NOT NULL,
      tokens_json TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      knowledge_base_id UNINDEXED,
      search_text,
      tokenize = 'unicode61'
    );
    CREATE TABLE knowledge_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO knowledge_bases VALUES ('kb-default', '默认知识库', '', 1000, 1000);
    INSERT INTO knowledge_bases VALUES ('kb-existing', 'Existing', 'legacy', 1001, 1001);
    INSERT INTO documents VALUES (
      'legacy-v2', 'legacy.md', 'legacy v2 content', 'kb-existing', 'ready', NULL, 1002, 1002
    );
    INSERT INTO chunks VALUES (
      'legacy-v2-chunk', 'legacy-v2', 'legacy.md', 'kb-existing', '[]',
      'legacy v2 marker', '["legacy","marker"]', '[0.5]', 'plain-text', 0, 1002
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const store = createKnowledgeStore(dbPath);
  assert.deepEqual(
    store.listKnowledgeBases().map(({ id, kind, projectRef }) => ({ id, kind, projectRef })),
    [
      { id: DEFAULT_KNOWLEDGE_BASE_ID, kind: 'generic', projectRef: null },
      { id: 'kb-existing', kind: 'generic', projectRef: null }
    ]
  );
  const common = store.getKnowledgeBase(COMMON_BUG_KNOWLEDGE_BASE_ID);
  assert.deepEqual(
    { id: common.id, kind: common.kind, projectRef: common.projectRef },
    { id: COMMON_BUG_KNOWLEDGE_BASE_ID, kind: 'common_bugs', projectRef: null }
  );
  assert.deepEqual(
    store.listDocuments().map(({ id, documentType, reviewStatus, publicationStatus, metadata }) => ({
      id,
      documentType,
      reviewStatus,
      publicationStatus,
      metadata
    })),
    [{
      id: 'legacy-v2',
      documentType: 'generic',
      reviewStatus: 'confirmed',
      publicationStatus: 'published',
      metadata: {}
    }]
  );
  assert.deepEqual(
    store.searchChunksByKeyword('v2 marker', 5).map((match) => match.chunkId),
    ['legacy-v2-chunk']
  );
  store.close();

  const migrated = new DatabaseSync(dbPath);
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(
    migrated.prepare('SELECT count(*) AS count FROM documents').get().count,
    1
  );
  migrated.close();
});

test('common Bug knowledge base creation is idempotent and refuses an occupied legacy id', () => {
  const dbPath = createTempDbPath();
  const first = createKnowledgeStore(dbPath);
  first.close();
  const second = createKnowledgeStore(dbPath);
  assert.equal(second.getKnowledgeBase(COMMON_BUG_KNOWLEDGE_BASE_ID).kind, 'common_bugs');
  second.close();

  const conflictPath = createTempDbPath();
  const conflict = new DatabaseSync(conflictPath);
  conflict.exec(`
    CREATE TABLE knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_name TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL, heading_path_json TEXT NOT NULL, text TEXT NOT NULL,
      tokens_json TEXT NOT NULL, embedding_json TEXT NOT NULL, kind TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE knowledge_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO knowledge_bases VALUES ('kb-default', '默认知识库', '', 1, 1);
    INSERT INTO knowledge_bases VALUES ('kb-common-bugs', '用户已有库', '不得覆盖', 2, 2);
    PRAGMA user_version = 2;
  `);
  conflict.close();

  assert.throws(
    () => createKnowledgeStore(conflictPath),
    (error) => error.code === 'COMMON_BUG_KNOWLEDGE_BASE_CONFLICT' && error.status === 409
  );
  const unchanged = new DatabaseSync(conflictPath);
  assert.equal(
    unchanged.prepare("SELECT name FROM knowledge_bases WHERE id = 'kb-common-bugs'").get().name,
    '用户已有库'
  );
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 2);
  unchanged.close();
});

test('generic store operations cannot mutate or clear system Bug knowledge bases', () => {
  const store = createKnowledgeStore(createTempDbPath());
  const common = store.getKnowledgeBase(COMMON_BUG_KNOWLEDGE_BASE_ID);

  assert.equal(common.kind, 'common_bugs');
  assert.throws(
    () => store.updateKnowledgeBase(common.id, { name: 'Hijacked' }),
    (error) => error.code === 'SYSTEM_KNOWLEDGE_BASE_PROTECTED' && error.status === 409
  );
  assert.throws(
    () => store.deleteKnowledgeBase(common.id, { force: true }),
    (error) => error.code === 'SYSTEM_KNOWLEDGE_BASE_PROTECTED' && error.status === 409
  );
  assert.throws(
    () => store.clearDocuments({ knowledgeBaseId: common.id }),
    (error) => error.code === 'SYSTEM_KNOWLEDGE_BASE_PROTECTED' && error.status === 409
  );
  assert.throws(
    () => store.insertQueuedDocuments([
      createDocument('not-a-bug-case', common.id)
    ]),
    (error) => error.code === 'SYSTEM_KNOWLEDGE_BASE_PROTECTED' && error.status === 409
  );
  store.close();
});

test('candidate and rejected Bug chunks stay ineligible after an FTS/cache rebuild', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);
  const project = store.createBugProject({
    projectRef: 'project-restart',
    knowledgeBaseId: 'kb-project-restart',
    name: 'Restart project'
  });
  store.insertBugCaseDocument({
    id: 'bug-restart',
    knowledgeBaseId: project.id,
    name: 'restart.bug.md',
    content: 'restartcandidate marker',
    metadata: { sourceProjectRef: project.projectRef }
  });
  store.replaceDocumentChunks('bug-restart', [
    createChunk('chunk-restart', 'bug-restart', 'restartcandidate marker')
  ]);
  store.updateDocumentStatus('bug-restart', 'ready');
  assert.deepEqual(store.searchChunksByKeyword('restartcandidate', 5), []);
  store.close();

  const reopened = createKnowledgeStore(dbPath);
  assert.deepEqual(reopened.loadState().chunks, []);
  assert.deepEqual(reopened.searchChunksByKeyword('restartcandidate', 5), []);
  reopened.reviewBugCaseDocument('bug-restart', {
    reviewStatus: 'confirmed',
    metadata: {
      sourceProjectRef: project.projectRef,
      reviewedBy: 'local-user',
      reviewReason: 'verified',
      reviewedAt: 2000
    },
    updatedAt: 2000
  });
  assert.equal(reopened.searchChunksByKeyword('restartcandidate', 5).length, 1);
  reopened.reviewBugCaseDocument('bug-restart', {
    reviewStatus: 'rejected',
    metadata: {
      sourceProjectRef: project.projectRef,
      reviewedBy: 'local-user',
      reviewReason: 'revoked',
      reviewedAt: 2001
    },
    updatedAt: 2001
  });
  assert.deepEqual(reopened.loadState().chunks, []);
  assert.deepEqual(reopened.searchChunksByKeyword('restartcandidate', 5), []);
  reopened.close();
});

test('Bug metadata must be a JSON object and promotion rolls back every scope on failure', () => {
  const dbPath = createTempDbPath();
  const store = createKnowledgeStore(dbPath);
  const project = store.createBugProject({
    projectRef: 'project-atomic',
    knowledgeBaseId: 'kb-project-atomic',
    name: 'Atomic project'
  });
  assert.throws(
    () => store.insertBugCaseDocument({
      id: 'bug-invalid-metadata',
      knowledgeBaseId: project.id,
      name: 'invalid.bug.md',
      content: 'invalid',
      metadata: ['not', 'an', 'object']
    }),
    (error) => error.code === 'INVALID_DOCUMENT_METADATA' && error.status === 400
  );

  store.insertBugCaseDocument({
    id: 'bug-atomic',
    knowledgeBaseId: project.id,
    name: 'atomic.bug.md',
    content: 'atomicpromotion marker',
    metadata: { sourceProjectRef: project.projectRef }
  });
  store.replaceDocumentChunks('bug-atomic', [
    createChunk('chunk-atomic', 'bug-atomic', 'atomicpromotion marker')
  ]);
  store.updateDocumentStatus('bug-atomic', 'ready');
  store.reviewBugCaseDocument('bug-atomic', {
    reviewStatus: 'confirmed',
    metadata: { sourceProjectRef: project.projectRef },
    updatedAt: 2000
  });

  const faultConnection = new DatabaseSync(dbPath);
  faultConnection.exec(`
    CREATE TRIGGER fail_bug_chunk_move
    BEFORE UPDATE OF knowledge_base_id ON chunks
    WHEN OLD.document_id = 'bug-atomic'
    BEGIN
      SELECT RAISE(ABORT, 'injected promotion failure');
    END;
  `);
  faultConnection.close();

  assert.throws(
    () => store.promoteBugCaseDocument('bug-atomic', 3000),
    /injected promotion failure/
  );
  assert.equal(store.getBugCaseDocument('bug-atomic').knowledgeBaseId, project.id);
  assert.equal(store.searchChunksByKeyword('atomicpromotion', 5, project.id).length, 1);
  assert.deepEqual(
    store.searchChunksByKeyword('atomicpromotion', 5, COMMON_BUG_KNOWLEDGE_BASE_ID),
    []
  );
  store.close();
});

test('document inserts reject missing knowledge bases and roll back the whole batch', () => {
  const store = createKnowledgeStore(createTempDbPath());

  assert.throws(
    () => store.insertDocumentsWithChunks(
      [
        createDocument('doc-valid'),
        createDocument('doc-invalid', 'kb-missing')
      ],
      []
    ),
    /Knowledge base not found/
  );
  assert.deepEqual(store.loadState().documents, []);
  store.close();
});
