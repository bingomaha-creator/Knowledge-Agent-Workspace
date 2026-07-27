import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expandCjkBigrams, tokenize } from './rag-utils.js';

// 知识库持久化层：管理“知识库 → 文档 → 分块”三层数据与 FTS5 倒排索引。
// 主要调用者是 mcp-server（上传、处理、检索和管理）以及研究 worker 的只读检索实例。
// 这里只负责 SQLite 中的一致性和关键词召回；不解析 Markdown、不请求 embedding，
// 也不完成向量/BM25 的最终融合排序。这些分别交给 markdown-chunker、mcp-server 和 rag-utils。
// 所有对外返回值都使用 camelCase，数据库列使用 snake_case，映射函数是两者的唯一转换边界。
const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/knowledge.sqlite');
const SCHEMA_VERSION = 4;
export const DEFAULT_KNOWLEDGE_BASE_ID = 'kb-default';
export const COMMON_BUG_KNOWLEDGE_BASE_ID = 'kb-common-bugs';
// 文档只能在这四个处理态之间流转；检索端会硬性排除非 ready 文档。
const DOCUMENT_STATUSES = new Set(['queued', 'processing', 'ready', 'failed']);
const DOCUMENT_TYPES = new Set(['generic', 'bug_case']);
const REVIEW_STATUSES = new Set(['candidate', 'confirmed', 'rejected']);
const PUBLICATION_STATUSES = new Set(['draft', 'published']);
const KNOWLEDGE_BASE_KINDS = new Set(['generic', 'project_bugs', 'common_bugs']);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapKnowledgeBase(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    kind: KNOWLEDGE_BASE_KINDS.has(row.kind) ? row.kind : 'generic',
    projectRef: row.project_ref || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDefault: row.id === DEFAULT_KNOWLEDGE_BASE_ID
  };
}

function mapDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    knowledgeBaseId: row.knowledge_base_id || DEFAULT_KNOWLEDGE_BASE_ID,
    status: DOCUMENT_STATUSES.has(row.status) ? row.status : 'ready',
    error: row.error || null,
    documentType: DOCUMENT_TYPES.has(row.document_type) ? row.document_type : 'generic',
    reviewStatus: REVIEW_STATUSES.has(row.review_status) ? row.review_status : 'confirmed',
    publicationStatus: PUBLICATION_STATUSES.has(row.publication_status)
      ? row.publication_status
      : 'published',
    publishedAt: row.published_at ?? null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at
  };
}

function mapChunk(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    knowledgeBaseId: row.knowledge_base_id || DEFAULT_KNOWLEDGE_BASE_ID,
    headingPath: parseJson(row.heading_path_json, []),
    text: row.text,
    tokens: parseJson(row.tokens_json, []),
    embedding: parseJson(row.embedding_json, []),
    kind: row.kind || 'plain-text',
    chunkIndex: row.chunk_index
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function quoteFtsTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

function buildChunkSearchText(chunk) {
  // FTS 索引不只放正文：文件名和标题路径也是用户常用的查询线索。
  // 额外写入中文双字组，是为了弥补 unicode61 对中文词边界的识别能力。
  const headingText = Array.isArray(chunk.headingPath) ? chunk.headingPath.join(' ') : '';
  const rawText = [chunk.documentName, headingText, chunk.text].filter(Boolean).join(' ');
  const baseTokens = Array.isArray(chunk.tokens) && chunk.tokens.length
    ? chunk.tokens
    : tokenize(rawText);
  return [rawText, ...expandCjkBigrams(baseTokens)].join(' ');
}

function buildFtsQuery(query) {
  // 每个词都作为字面量用 OR 连接；限制 32 项避免超长输入生成庞大 MATCH 表达式。
  const terms = unique(expandCjkBigrams(tokenize(query))).slice(0, 32);
  return terms.map(quoteFtsTerm).join(' OR ');
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE (type = 'table' OR type = 'view') AND name = ?
  `).get(name));
}

function tableColumns(db, name) {
  if (!tableExists(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name));
}

function normalizeScope(scope) {
  // scope 的三种语义必须区分：
  // - undefined/null：没有限制，可查所有知识库；
  // - [] 或 { knowledgeBaseIds: [] }：用户明确选择“不使用知识库”，必须返回空集；
  // - 字符串/非空数组：仅限这些 ID。
  // 若把空数组误当作“全部”，会造成跨工作区检索和删除。
  if (scope === undefined || scope === null) return null;

  let ids;
  if (typeof scope === 'string') {
    ids = [scope];
  } else if (Array.isArray(scope)) {
    ids = scope;
  } else if (typeof scope === 'object') {
    if (Object.hasOwn(scope, 'knowledgeBaseIds')) {
      ids = Array.isArray(scope.knowledgeBaseIds)
        ? scope.knowledgeBaseIds
        : [scope.knowledgeBaseIds];
    } else if (Object.hasOwn(scope, 'knowledgeBaseId')) {
      ids = [scope.knowledgeBaseId];
    } else {
      return null;
    }
  } else {
    ids = [];
  }

  return unique(ids.map((id) => String(id || '').trim()));
}

function normalizeStatus(status, fallback) {
  const normalized = String(status || fallback || '').trim();
  if (!DOCUMENT_STATUSES.has(normalized)) {
    throw new TypeError(`Invalid document status: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function normalizeDocumentType(value, fallback = 'generic') {
  const normalized = String(value || fallback).trim();
  if (!DOCUMENT_TYPES.has(normalized)) {
    throw new TypeError(`Invalid document type: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function normalizeReviewStatus(value, fallback = 'confirmed') {
  const normalized = String(value || fallback).trim();
  if (!REVIEW_STATUSES.has(normalized)) {
    throw new TypeError(`Invalid review status: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function normalizePublicationStatus(value, fallback = 'published') {
  const normalized = String(value || fallback).trim();
  if (!PUBLICATION_STATUSES.has(normalized)) {
    throw new TypeError(`Invalid publication status: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createStoreError('INVALID_DOCUMENT_METADATA', 'Document metadata must be an object', 400);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw createStoreError('INVALID_DOCUMENT_METADATA', 'Document metadata must be JSON serializable', 400);
  }
}

function readableError(error) {
  if (error === undefined || error === null || error === '') return null;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function createStoreError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function migrateDatabase(db) {
  // 迁移在打开 store 时同步执行，PRAGMA user_version 是唯一版本标记。
  // BEGIN IMMEDIATE 会提前取得写锁，使建表、补列、回填旧数据和更新版本成为一个原子单元。
  // v1 之前的文档统一归入默认知识库并视为 ready，因此升级不会丢失旧 RAG 数据。
  // 如果发现数据库版本高于当前代码，直接拒绝打开，避免旧代码破坏新 schema。
  const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(`Knowledge database schema v${version} is newer than supported v${SCHEMA_VERSION}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'generic'
          CHECK (kind IN ('generic', 'project_bugs', 'common_bugs')),
        project_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (kind = 'project_bugs' AND project_ref IS NOT NULL AND length(trim(project_ref)) > 0)
          OR (kind != 'project_bugs' AND project_ref IS NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL DEFAULT '${DEFAULT_KNOWLEDGE_BASE_ID}',
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
        error TEXT,
        document_type TEXT NOT NULL DEFAULT 'generic'
          CHECK (document_type IN ('generic', 'bug_case')),
        review_status TEXT NOT NULL DEFAULT 'confirmed'
          CHECK (review_status IN ('candidate', 'confirmed', 'rejected')),
        metadata_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
        publication_status TEXT NOT NULL DEFAULT 'published'
          CHECK (publication_status IN ('draft', 'published')),
        published_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL DEFAULT '${DEFAULT_KNOWLEDGE_BASE_ID}',
        heading_path_json TEXT NOT NULL,
        text TEXT NOT NULL,
        tokens_json TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const now = Date.now();
    db.prepare(`
      INSERT INTO knowledge_bases (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(DEFAULT_KNOWLEDGE_BASE_ID, '默认知识库', '兼容升级前文档的默认知识库', now, now);

    const knowledgeBaseColumns = tableColumns(db, 'knowledge_bases');
    if (!knowledgeBaseColumns.has('kind')) {
      db.exec("ALTER TABLE knowledge_bases ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('generic', 'project_bugs', 'common_bugs'))");
    }
    if (!knowledgeBaseColumns.has('project_ref')) {
      db.exec('ALTER TABLE knowledge_bases ADD COLUMN project_ref TEXT');
    }

    const documentColumns = tableColumns(db, 'documents');
    if (!documentColumns.has('knowledge_base_id')) {
      db.exec(`ALTER TABLE documents ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT '${DEFAULT_KNOWLEDGE_BASE_ID}'`);
    }
    if (!documentColumns.has('status')) {
      db.exec("ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'processing', 'ready', 'failed'))");
    }
    if (!documentColumns.has('error')) {
      db.exec('ALTER TABLE documents ADD COLUMN error TEXT');
    }
    if (!documentColumns.has('updated_at')) {
      db.exec('ALTER TABLE documents ADD COLUMN updated_at INTEGER');
    }
    if (!documentColumns.has('document_type')) {
      db.exec("ALTER TABLE documents ADD COLUMN document_type TEXT NOT NULL DEFAULT 'generic' CHECK (document_type IN ('generic', 'bug_case'))");
    }
    if (!documentColumns.has('review_status')) {
      db.exec("ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (review_status IN ('candidate', 'confirmed', 'rejected'))");
    }
    if (!documentColumns.has('metadata_json')) {
      db.exec("ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object')");
    }
    if (!documentColumns.has('publication_status')) {
      // Existing documents were already eligible before Phase B, so additive migration must
      // preserve that behaviour. Only new generic uploads start as drafts.
      db.exec("ALTER TABLE documents ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'published' CHECK (publication_status IN ('draft', 'published'))");
    }
    if (!documentColumns.has('published_at')) {
      db.exec('ALTER TABLE documents ADD COLUMN published_at INTEGER');
    }

    const chunkColumns = tableColumns(db, 'chunks');
    if (!chunkColumns.has('knowledge_base_id')) {
      db.exec(`ALTER TABLE chunks ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT '${DEFAULT_KNOWLEDGE_BASE_ID}'`);
    }

    db.exec(`
      UPDATE knowledge_bases
      SET kind = 'generic', project_ref = NULL
      WHERE kind IS NULL OR kind NOT IN ('generic', 'project_bugs', 'common_bugs');

      UPDATE documents
      SET knowledge_base_id = '${DEFAULT_KNOWLEDGE_BASE_ID}'
      WHERE knowledge_base_id IS NULL OR knowledge_base_id = '';

      UPDATE documents
      SET status = 'ready'
      WHERE status IS NULL OR status NOT IN ('queued', 'processing', 'ready', 'failed');

      UPDATE documents
      SET updated_at = created_at
      WHERE updated_at IS NULL;

      UPDATE documents
      SET document_type = 'generic'
      WHERE document_type IS NULL OR document_type NOT IN ('generic', 'bug_case');

      UPDATE documents
      SET review_status = CASE WHEN document_type = 'bug_case' THEN 'candidate' ELSE 'confirmed' END
      WHERE review_status IS NULL OR review_status NOT IN ('candidate', 'confirmed', 'rejected');

      UPDATE documents
      SET metadata_json = '{}'
      WHERE metadata_json IS NULL
         OR NOT json_valid(metadata_json)
         OR json_type(metadata_json) != 'object';

      UPDATE documents
      SET publication_status = 'published'
      WHERE publication_status IS NULL OR publication_status NOT IN ('draft', 'published');

      UPDATE documents
      SET published_at = COALESCE(published_at, updated_at, created_at)
      WHERE publication_status = 'published' AND published_at IS NULL;

      UPDATE documents
      SET published_at = NULL
      WHERE publication_status = 'draft';

      UPDATE chunks
      SET knowledge_base_id = COALESCE(
        (SELECT documents.knowledge_base_id FROM documents WHERE documents.id = chunks.document_id),
        '${DEFAULT_KNOWLEDGE_BASE_ID}'
      )
      WHERE knowledge_base_id IS NULL
         OR knowledge_base_id = ''
         OR knowledge_base_id != COALESCE(
           (SELECT documents.knowledge_base_id FROM documents WHERE documents.id = chunks.document_id),
           '${DEFAULT_KNOWLEDGE_BASE_ID}'
         );

      CREATE INDEX IF NOT EXISTS idx_documents_knowledge_base_id
        ON documents(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_documents_status
        ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_documents_document_type
        ON documents(document_type);
      CREATE INDEX IF NOT EXISTS idx_documents_review_status
        ON documents(review_status);
      CREATE INDEX IF NOT EXISTS idx_documents_publication_status
        ON documents(publication_status);
      CREATE INDEX IF NOT EXISTS idx_chunks_document_id
        ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_knowledge_base_id
        ON chunks(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_bases_kind
        ON knowledge_bases(kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_bases_project_ref
        ON knowledge_bases(project_ref)
        WHERE kind = 'project_bugs';

      CREATE TRIGGER IF NOT EXISTS validate_knowledge_base_scope_insert
      BEFORE INSERT ON knowledge_bases
      WHEN (NEW.kind = 'project_bugs' AND (NEW.project_ref IS NULL OR length(trim(NEW.project_ref)) = 0))
        OR (NEW.kind != 'project_bugs' AND NEW.project_ref IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid knowledge base scope');
      END;

      CREATE TRIGGER IF NOT EXISTS validate_knowledge_base_scope_update
      BEFORE UPDATE OF kind, project_ref ON knowledge_bases
      WHEN (NEW.kind = 'project_bugs' AND (NEW.project_ref IS NULL OR length(trim(NEW.project_ref)) = 0))
        OR (NEW.kind != 'project_bugs' AND NEW.project_ref IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid knowledge base scope');
      END;
    `);

    // 公共 Bug 库是系统身份而非名称约定。固定 ID 被旧 generic 库占用时必须整批回滚，
    // 不能为了启动成功而悄悄改写用户已有的数据。
    const commonBase = db.prepare(`
      SELECT id, kind FROM knowledge_bases WHERE id = ?
    `).get(COMMON_BUG_KNOWLEDGE_BASE_ID);
    if (commonBase && commonBase.kind !== 'common_bugs') {
      throw createStoreError(
        'COMMON_BUG_KNOWLEDGE_BASE_CONFLICT',
        `Knowledge base id ${COMMON_BUG_KNOWLEDGE_BASE_ID} is already occupied`,
        409
      );
    }
    if (!commonBase) {
      db.prepare(`
        INSERT INTO knowledge_bases (
          id, name, description, kind, project_ref, created_at, updated_at
        ) VALUES (?, ?, ?, 'common_bugs', NULL, ?, ?)
      `).run(
        COMMON_BUG_KNOWLEDGE_BASE_ID,
        '公共 Bug 知识库',
        '经过人工确认、可跨项目复用的 BugCase',
        now,
        now
      );
    }

    const ftsColumns = tableColumns(db, 'chunks_fts');
    if (ftsColumns.size && !ftsColumns.has('knowledge_base_id')) {
      // FTS5 虚拟表不能像普通表一样安全 ALTER 补列，旧索引会在事务内丢弃，稍后由 chunks 真实数据重建。
      db.exec('DROP TABLE chunks_fts');
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        knowledge_base_id UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createKnowledgeStore(dbPath = DEFAULT_DB_PATH) {
  // 工厂函数打开一个长生命周期同步连接，并返回闭包式 repository API。
  // WAL 允许后台文档处理写入时仍有读者；foreign_keys 则保证 chunk 不会脱离 document。
  // 预编译 statement 只在初始化时创建一次；测试或需要主动释放文件锁时可调用 close()。
  // 本函数不维护 mcp-server 的内存缓存；写入后由业务层决定何时 reload。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  try {
    migrateDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const selectKnowledgeBase = db.prepare(`
    SELECT id, name, description, kind, project_ref, created_at, updated_at
    FROM knowledge_bases
    WHERE id = ?
  `);
  const selectKnowledgeBases = db.prepare(`
    SELECT id, name, description, kind, project_ref, created_at, updated_at
    FROM knowledge_bases
    WHERE kind = 'generic'
    ORDER BY CASE WHEN id = '${DEFAULT_KNOWLEDGE_BASE_ID}' THEN 0 ELSE 1 END,
             created_at ASC,
             name COLLATE NOCASE ASC
  `);
  const selectBugProjects = db.prepare(`
    SELECT id, name, description, kind, project_ref, created_at, updated_at
    FROM knowledge_bases
    WHERE kind = 'project_bugs'
    ORDER BY created_at ASC, project_ref ASC
  `);
  const selectBugProjectByRef = db.prepare(`
    SELECT id, name, description, kind, project_ref, created_at, updated_at
    FROM knowledge_bases
    WHERE kind = 'project_bugs' AND project_ref = ?
  `);
  const insertKnowledgeBase = db.prepare(`
    INSERT INTO knowledge_bases (
      id, name, description, kind, project_ref, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateKnowledgeBaseStatement = db.prepare(`
    UPDATE knowledge_bases
    SET name = ?, description = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteKnowledgeBaseStatement = db.prepare('DELETE FROM knowledge_bases WHERE id = ?');
  const countKnowledgeBaseDocuments = db.prepare(`
    SELECT count(*) AS count
    FROM documents
    WHERE knowledge_base_id = ?
  `);

  const insertDocument = db.prepare(`
    INSERT INTO documents (
      id, name, content, knowledge_base_id, status, error,
      document_type, review_status, metadata_json, publication_status,
      published_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectDocument = db.prepare(`
    SELECT id, name, content, knowledge_base_id, status, error,
           document_type, review_status, metadata_json, publication_status,
           published_at, created_at, updated_at
    FROM documents
    WHERE id = ?
  `);
  const updateDocumentStatusStatement = db.prepare(`
    UPDATE documents
    SET status = ?, error = ?, updated_at = ?
    WHERE id = ?
  `);
  const claimDocumentForIndexStatement = db.prepare(`
    UPDATE documents
    SET status = 'processing', error = NULL, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'processing')
  `);
  const failDocumentIndexStatement = db.prepare(`
    UPDATE documents
    SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ? AND status = 'processing'
  `);
  const countDocumentChunks = db.prepare(`
    SELECT count(*) AS count FROM chunks WHERE document_id = ?
  `);
  const countChunks = db.prepare('SELECT count(*) AS count FROM chunks');
  const selectDocumentChunks = db.prepare(`
    SELECT id, document_id, document_name, knowledge_base_id,
           heading_path_json, text, tokens_json, embedding_json, kind, chunk_index
    FROM chunks
    WHERE document_id = ?
    ORDER BY chunk_index ASC, created_at ASC
  `);
  const publishDocumentStatement = db.prepare(`
    UPDATE documents
    SET publication_status = 'published', published_at = ?, updated_at = ?
    WHERE id = ? AND document_type = 'generic' AND status = 'ready'
      AND publication_status = 'draft'
  `);
  const withdrawDocumentStatement = db.prepare(`
    UPDATE documents
    SET publication_status = 'draft', published_at = NULL, updated_at = ?
    WHERE id = ? AND document_type = 'generic' AND publication_status = 'published'
  `);
  const updateBugCaseContentStatement = db.prepare(`
    UPDATE documents
    SET name = ?, content = ?, status = 'queued', error = NULL,
        review_status = 'candidate', metadata_json = ?, updated_at = ?
    WHERE id = ? AND document_type = 'bug_case'
  `);
  const updateBugCaseReviewStatement = db.prepare(`
    UPDATE documents
    SET review_status = ?, metadata_json = ?, updated_at = ?
    WHERE id = ? AND document_type = 'bug_case'
  `);
  const moveBugCaseDocumentStatement = db.prepare(`
    UPDATE documents
    SET knowledge_base_id = ?, updated_at = ?
    WHERE id = ? AND document_type = 'bug_case'
  `);
  const moveBugCaseChunksStatement = db.prepare(`
    UPDATE chunks SET knowledge_base_id = ? WHERE document_id = ?
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (
      id,
      document_id,
      document_name,
      knowledge_base_id,
      heading_path_json,
      text,
      tokens_json,
      embedding_json,
      kind,
      chunk_index,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunkFts = db.prepare(`
    INSERT INTO chunks_fts (chunk_id, document_id, knowledge_base_id, search_text)
    VALUES (?, ?, ?, ?)
  `);
  const selectChunksForRebuild = db.prepare(`
    SELECT
      id,
      document_id,
      document_name,
      knowledge_base_id,
      heading_path_json,
      text,
      tokens_json,
      embedding_json,
      kind,
      chunk_index
    FROM chunks
    ORDER BY created_at ASC, chunk_index ASC
  `);
  const deleteDocumentStatement = db.prepare('DELETE FROM documents WHERE id = ?');
  const deleteDocumentChunks = db.prepare('DELETE FROM chunks WHERE document_id = ?');
  const deleteDocumentFts = db.prepare('DELETE FROM chunks_fts WHERE document_id = ?');
  const clearFts = db.prepare('DELETE FROM chunks_fts');
  const selectMetadata = db.prepare('SELECT value FROM knowledge_metadata WHERE key = ?');
  const upsertMetadata = db.prepare(`
    INSERT INTO knowledge_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const queuedDocumentListeners = new Set();

  function publishQueuedDocuments(documentIds) {
    const ids = unique(documentIds);
    if (!ids.length) return;
    for (const listener of queuedDocumentListeners) {
      try {
        listener(ids);
      } catch {
        // The committed queued state is durable; startup recovery remains the fallback.
      }
    }
  }

  function indexChunk(chunk, knowledgeBaseId) {
    // chunks 是权威数据，chunks_fts 是可重建的派生索引；两者的写入由上层事务包住。
    insertChunkFts.run(
      chunk.id,
      chunk.documentId,
      knowledgeBaseId,
      buildChunkSearchText(chunk)
    );
  }

  function insertChunkRow(chunk, knowledgeBaseId, createdAt = Date.now()) {
    insertChunk.run(
      chunk.id,
      chunk.documentId,
      chunk.documentName,
      knowledgeBaseId,
      JSON.stringify(chunk.headingPath || []),
      chunk.text,
      JSON.stringify(chunk.tokens || []),
      JSON.stringify(chunk.embedding || []),
      chunk.kind || 'plain-text',
      chunk.chunkIndex ?? 0,
      createdAt
    );
    indexChunk(chunk, knowledgeBaseId);
  }

  function requireKnowledgeBase(id, allowedKinds = ['generic']) {
    const knowledgeBaseId = String(id || DEFAULT_KNOWLEDGE_BASE_ID).trim() || DEFAULT_KNOWLEDGE_BASE_ID;
    const row = selectKnowledgeBase.get(knowledgeBaseId);
    if (!row) {
      throw new Error(`Knowledge base not found: ${knowledgeBaseId}`);
    }
    if (!allowedKinds.includes(row.kind)) {
      throw createStoreError(
        'SYSTEM_KNOWLEDGE_BASE_PROTECTED',
        `Knowledge base ${knowledgeBaseId} is managed by the Bug knowledge domain`,
        409
      );
    }
    return knowledgeBaseId;
  }

  function insertDocumentRow(document, fallbackStatus, {
    allowBugCase = false,
    defaultPublicationStatus = 'published'
  } = {}) {
    // 在真正 INSERT 前先校验知识库与状态，防止把不可检索的“半合法”数据写入。
    const documentType = normalizeDocumentType(document.documentType);
    if (documentType === 'bug_case' && !allowBugCase) {
      throw createStoreError(
        'BUG_CASE_REQUIRES_DEDICATED_API',
        'BugCase documents must use the dedicated Bug knowledge API',
        409
      );
    }
    const allowedKinds = documentType === 'bug_case'
      ? ['project_bugs', 'common_bugs']
      : ['generic'];
    const knowledgeBaseId = requireKnowledgeBase(document.knowledgeBaseId, allowedKinds);
    const createdAt = Number.isFinite(document.createdAt) ? document.createdAt : Date.now();
    const updatedAt = Number.isFinite(document.updatedAt) ? document.updatedAt : createdAt;
    const status = normalizeStatus(document.status, fallbackStatus);
    const error = status === 'failed' ? readableError(document.error) : null;
    const reviewStatus = normalizeReviewStatus(
      document.reviewStatus,
      documentType === 'bug_case' ? 'candidate' : 'confirmed'
    );
    if (documentType === 'generic' && reviewStatus !== 'confirmed') {
      throw createStoreError(
        'INVALID_GENERIC_REVIEW_STATUS',
        'Generic documents must remain confirmed',
        400
      );
    }
    const metadata = normalizeMetadata(document.metadata);
    const publicationStatus = normalizePublicationStatus(
      document.publicationStatus,
      defaultPublicationStatus
    );
    const publishedAt = publicationStatus === 'published'
      ? (Number.isFinite(document.publishedAt) ? document.publishedAt : updatedAt)
      : null;
    insertDocument.run(
      document.id,
      document.name,
      document.content || '',
      knowledgeBaseId,
      status,
      error,
      documentType,
      reviewStatus,
      JSON.stringify(metadata),
      publicationStatus,
      publishedAt,
      createdAt,
      updatedAt
    );
    return { knowledgeBaseId, status };
  }

  function documentsSql(scope, statuses, { genericOnly = false } = {}) {
    // 只拼接固定 SQL 片段，所有外部值仍通过 ? 绑定；empty 用于短路“明确空范围”。
    const ids = normalizeScope(scope);
    if (ids?.length === 0) return { sql: '', params: [], empty: true };

    const conditions = [];
    const params = [];
    if (ids) {
      conditions.push(`knowledge_base_id IN (${placeholders(ids)})`);
      params.push(...ids);
    }
    if (statuses) {
      conditions.push(`status IN (${placeholders(statuses)})`);
      params.push(...statuses);
    }
    if (genericOnly) conditions.push("document_type = 'generic'");

    return {
      sql: `
        SELECT id, name, content, knowledge_base_id, status, error,
               document_type, review_status, metadata_json, publication_status,
               published_at, created_at, updated_at
        FROM documents
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at ASC, id ASC
      `,
      params,
      empty: false
    };
  }

  function listDocuments(scope) {
    const query = documentsSql(scope, undefined, { genericOnly: true });
    if (query.empty) return [];
    return db.prepare(query.sql).all(...query.params).map(mapDocument);
  }

  function listAllDocuments(scope, statuses) {
    const query = documentsSql(scope, statuses);
    if (query.empty) return [];
    return db.prepare(query.sql).all(...query.params).map(mapDocument);
  }

  function listChunks(scope, readyOnly = true) {
    // JOIN documents 不是为了补字段，而是为了在 SQL 层落实
    // “只有 ready + published 文档可召回”的不变量。
    const ids = normalizeScope(scope);
    if (ids?.length === 0) return [];
    const conditions = readyOnly
      ? [
          "documents.status = 'ready'",
          "documents.publication_status = 'published'",
          "(documents.document_type != 'bug_case' OR documents.review_status = 'confirmed')"
        ]
      : [];
    const params = [];
    if (ids) {
      conditions.push(`chunks.knowledge_base_id IN (${placeholders(ids)})`);
      params.push(...ids);
    }
    return db.prepare(`
      SELECT
        chunks.id,
        chunks.document_id,
        chunks.document_name,
        chunks.knowledge_base_id,
        chunks.heading_path_json,
        chunks.text,
        chunks.tokens_json,
        chunks.embedding_json,
        chunks.kind,
        chunks.chunk_index
      FROM chunks
      JOIN documents ON documents.id = chunks.document_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY chunks.created_at ASC, chunks.chunk_index ASC
    `).all(...params).map(mapChunk);
  }

  function deleteScopedRows(scope) {
    // 删除顺序是 FTS 派生行 → chunk → document。此 helper 本身不开事务，
    // 只能由 deleteKnowledgeBase/clearDocuments 这类已建立事务边界的方法调用。
    const ids = normalizeScope(scope);
    if (ids?.length === 0) return 0;

    const where = ids ? `WHERE knowledge_base_id IN (${placeholders(ids)})` : '';
    const params = ids || [];
    db.prepare(`DELETE FROM chunks_fts ${where}`).run(...params);
    db.prepare(`DELETE FROM chunks ${where}`).run(...params);
    return db.prepare(`DELETE FROM documents ${where}`).run(...params).changes;
  }

  // 每次打开时从 chunks 重建 FTS：既完成 v1 索引迁移，也修复旧版本异常中断留下的脏索引。
  // 重建可能比增量校验慢，但它保持了一个简单且可验证的原则：真实数据存在 chunks，FTS 随时可丢弃重建。
  db.exec('BEGIN');
  try {
    clearFts.run();
    for (const chunk of selectChunksForRebuild.all().map(mapChunk)) {
      indexChunk(chunk, chunk.knowledgeBaseId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  return {
    listKnowledgeBases() {
      return selectKnowledgeBases.all().map(mapKnowledgeBase);
    },

    getKnowledgeBase(id) {
      return mapKnowledgeBase(selectKnowledgeBase.get(id));
    },

    listBugProjects() {
      return selectBugProjects.all().map(mapKnowledgeBase);
    },

    getBugProject(projectRef) {
      return mapKnowledgeBase(selectBugProjectByRef.get(String(projectRef || '').trim()));
    },

    createBugProject(input = {}) {
      const projectRef = String(input.projectRef || '').trim();
      const id = String(input.knowledgeBaseId || '').trim();
      const name = String(input.name || '').trim();
      if (!projectRef) throw new TypeError('Bug projectRef is required');
      if (!id) throw new TypeError('Bug project knowledgeBaseId is required');
      if (!name) throw new TypeError('Bug project name is required');
      const description = String(input.description || '').trim();
      const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
      const updatedAt = Number.isFinite(input.updatedAt) ? input.updatedAt : createdAt;
      insertKnowledgeBase.run(
        id,
        name,
        description,
        'project_bugs',
        projectRef,
        createdAt,
        updatedAt
      );
      return mapKnowledgeBase(selectBugProjectByRef.get(projectRef));
    },

    updateBugProject(projectRef, patch = {}) {
      const current = mapKnowledgeBase(selectBugProjectByRef.get(String(projectRef || '').trim()));
      if (!current) return null;
      const name = patch.name === undefined ? current.name : String(patch.name || '').trim();
      if (!name) throw new TypeError('Bug project name is required');
      const description = patch.description === undefined
        ? current.description
        : String(patch.description || '').trim();
      const updatedAt = Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now();
      // 只更新展示字段；不可变 project_ref 与系统 knowledge-base id 不进入 SET 子句。
      updateKnowledgeBaseStatement.run(name, description, updatedAt, current.id);
      return mapKnowledgeBase(selectBugProjectByRef.get(current.projectRef));
    },

    createKnowledgeBase(input) {
      const values = typeof input === 'string' ? { name: input } : (input || {});
      const name = String(values.name || '').trim();
      if (!name) throw new TypeError('Knowledge base name is required');
      const id = String(values.id || `kb-${randomUUID()}`).trim();
      if (!id) throw new TypeError('Knowledge base id is required');
      const description = String(values.description || '').trim();
      const now = Date.now();
      // 通用入口永远只能创建 generic；project/common 身份只能由专用 Bug 方法产生。
      insertKnowledgeBase.run(id, name, description, 'generic', null, now, now);
      return mapKnowledgeBase(selectKnowledgeBase.get(id));
    },

    updateKnowledgeBase(id, patch = {}) {
      const current = mapKnowledgeBase(selectKnowledgeBase.get(id));
      if (!current) return null;
      if (current.kind !== 'generic') {
        throw createStoreError(
          'SYSTEM_KNOWLEDGE_BASE_PROTECTED',
          `Knowledge base ${id} is managed by the Bug knowledge domain`,
          409
        );
      }
      const name = patch.name === undefined ? current.name : String(patch.name || '').trim();
      if (!name) throw new TypeError('Knowledge base name is required');
      const description = patch.description === undefined
        ? current.description
        : String(patch.description || '').trim();
      updateKnowledgeBaseStatement.run(name, description, Date.now(), id);
      return mapKnowledgeBase(selectKnowledgeBase.get(id));
    },

    deleteKnowledgeBase(id, options = {}) {
      // 默认库承载旧数据兼容语义，始终禁止删除。非空库默认也拒绝，
      // 只有明确 force 时才在同一事务中删文档、chunk、FTS 和知识库本身。
      if (id === DEFAULT_KNOWLEDGE_BASE_ID) {
        throw createStoreError(
          'DEFAULT_KNOWLEDGE_BASE_PROTECTED',
          'The default knowledge base cannot be deleted',
          409
        );
      }
      const current = mapKnowledgeBase(selectKnowledgeBase.get(id));
      if (!current) {
        throw createStoreError(
          'KNOWLEDGE_BASE_NOT_FOUND',
          `Knowledge base not found: ${id}`,
          404
        );
      }
      if (current.kind !== 'generic') {
        throw createStoreError(
          'SYSTEM_KNOWLEDGE_BASE_PROTECTED',
          `Knowledge base ${id} is managed by the Bug knowledge domain`,
          409
        );
      }

      const documentCount = Number(countKnowledgeBaseDocuments.get(id).count || 0);
      if (documentCount > 0 && !options.force) {
        throw createStoreError(
          'KNOWLEDGE_BASE_NOT_EMPTY',
          `Knowledge base is not empty: ${id}`,
          409
        );
      }

      db.exec('BEGIN');
      try {
        deleteScopedRows({ knowledgeBaseId: id });
        const result = deleteKnowledgeBaseStatement.run(id);
        db.exec('COMMIT');
        return result.changes
          ? { ok: true, id, deletedDocuments: documentCount }
          : 0;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    listDocuments,

    getDocument(id) {
      const document = mapDocument(selectDocument.get(id));
      return document?.documentType === 'generic' ? document : null;
    },

    listDocumentChunks(id) {
      const document = mapDocument(selectDocument.get(id));
      if (!document || document.documentType !== 'generic') return [];
      return selectDocumentChunks.all(id).map(mapChunk);
    },

    hasStoredChunks() {
      // 这里故意计入草稿的预索引：embedding 模型兼容性是物理索引约束，
      // 不能因为草稿暂时不可检索就误判为空库。
      return Number(countChunks.get().count || 0) > 0;
    },

    listDocumentsByStatus(statuses, scope) {
      const requestedStatuses = unique(
        (Array.isArray(statuses) ? statuses : [statuses]).map((status) => normalizeStatus(status))
      );
      if (!requestedStatuses.length) return [];
      return listAllDocuments(scope, requestedStatuses);
    },

    loadState(scope) {
      // 返回调用时的 SQLite 快照：管理界面需要看到全部文档，
      // 而检索只能加载 ready 文档的 chunks。
      return {
        // 后台处理器必须看到 BugCase candidate，管理 API 的 generic 过滤不能影响作业恢复。
        documents: listAllDocuments(scope),
        // Only ready + published documents may participate in vector retrieval after restart.
        chunks: listChunks(scope, true)
      };
    },

    insertQueuedDocuments(documents) {
      // 上传阶段只持久化原文和 queued 状态，不在这个事务中做耗时的分块/embedding。
      // 整批文档要么全部写入，要么回滚；提交后通知 Lifecycle，启动扫描仍是可靠兜底。
      db.exec('BEGIN');
      try {
        for (const document of documents) {
          insertDocumentRow({
            ...document,
            documentType: 'generic',
            reviewStatus: 'confirmed',
            metadata: {},
            publicationStatus: 'draft',
            status: 'queued',
            error: null
          }, 'queued', { defaultPublicationStatus: 'draft' });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const inserted = documents.map((document) => mapDocument(selectDocument.get(document.id)));
      publishQueuedDocuments(inserted.map((document) => document.id));
      return inserted;
    },

    insertDocumentsWithChunks(documents, chunks) {
      // 兼容同步导入路径：文档和已生成的 chunk 在同一事务内落库。
      // knowledgeBaseByDocumentId 保证 chunk 继承父文档的范围，不信任调用者在 chunk 上重复携带的范围。
      const knowledgeBaseByDocumentId = new Map();
      db.exec('BEGIN');
      try {
        for (const document of documents) {
          const inserted = insertDocumentRow({
            ...document,
            documentType: 'generic',
            reviewStatus: 'confirmed',
            metadata: {}
          }, 'ready');
          knowledgeBaseByDocumentId.set(document.id, inserted.knowledgeBaseId);
        }

        for (const chunk of chunks) {
          const knowledgeBaseId = knowledgeBaseByDocumentId.get(chunk.documentId)
            || mapDocument(selectDocument.get(chunk.documentId))?.knowledgeBaseId;
          if (!knowledgeBaseId) {
            throw new Error(`Document not found for chunk ${chunk.id}: ${chunk.documentId}`);
          }
          insertChunkRow(chunk, knowledgeBaseId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    replaceDocumentChunks(documentId, chunks) {
      // 后台处理完成后原子替换该文档的旧 chunk 和 FTS 行，避免读者看到一半新一半旧。
      // 状态转为 ready 是业务层的下一步，本方法只负责分块替换。
      const document = mapDocument(selectDocument.get(documentId));
      if (!document) throw new Error(`Document not found: ${documentId}`);
      if (chunks.some((chunk) => chunk.documentId !== documentId)) {
        throw new Error(`Every replacement chunk must belong to document ${documentId}`);
      }

      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(documentId);
        deleteDocumentChunks.run(documentId);
        for (const chunk of chunks) {
          insertChunkRow(chunk, document.knowledgeBaseId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return chunks.length;
    },

    claimDocumentForIndex(id) {
      const result = claimDocumentForIndexStatement.run(Date.now(), id);
      return result.changes ? mapDocument(selectDocument.get(id)) : null;
    },

    completeDocumentIndex(documentId, chunks) {
      const document = mapDocument(selectDocument.get(documentId));
      // 编辑会把同一文档重新置为 queued。旧 worker 只能结算它领取的 processing
      // 代际，不能用旧 chunk 覆盖刚提交的新原文。
      if (!document || document.status !== 'processing') return null;
      if (chunks.some((chunk) => chunk.documentId !== documentId)) {
        throw new Error(`Every replacement chunk must belong to document ${documentId}`);
      }

      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(documentId);
        deleteDocumentChunks.run(documentId);
        for (const chunk of chunks) {
          insertChunkRow(chunk, document.knowledgeBaseId);
        }
        updateDocumentStatusStatement.run('ready', null, Date.now(), documentId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return mapDocument(selectDocument.get(documentId));
    },

    failDocumentIndex(id, error) {
      // 与成功结算相同，过期 worker 的失败不能污染已经重新 queued 的新代际。
      const result = failDocumentIndexStatement.run(
        readableError(error),
        Date.now(),
        id
      );
      return result.changes ? mapDocument(selectDocument.get(id)) : null;
    },

    publishDocument(id, publishedAt = Date.now()) {
      const current = mapDocument(selectDocument.get(id));
      if (!current || current.documentType !== 'generic') {
        throw createStoreError('DOCUMENT_NOT_FOUND', `Knowledge document not found: ${id}`, 404);
      }
      if (current.publicationStatus === 'published') return current;
      if (current.status !== 'ready') {
        throw createStoreError(
          'DOCUMENT_NOT_READY',
          'Knowledge document must finish processing before publication',
          409
        );
      }
      if (Number(countDocumentChunks.get(id).count || 0) < 1) {
        throw createStoreError(
          'DOCUMENT_HAS_NO_INDEX',
          'Knowledge document has no indexable content',
          409
        );
      }
      const timestamp = Number.isFinite(publishedAt) ? publishedAt : Date.now();
      const result = publishDocumentStatement.run(timestamp, timestamp, id);
      return result.changes ? mapDocument(selectDocument.get(id)) : null;
    },

    withdrawDocument(id, withdrawnAt = Date.now()) {
      const current = mapDocument(selectDocument.get(id));
      if (!current || current.documentType !== 'generic') {
        throw createStoreError('DOCUMENT_NOT_FOUND', `Knowledge document not found: ${id}`, 404);
      }
      if (current.publicationStatus === 'draft') return current;
      const timestamp = Number.isFinite(withdrawnAt) ? withdrawnAt : Date.now();
      const result = withdrawDocumentStatement.run(timestamp, id);
      return result.changes ? mapDocument(selectDocument.get(id)) : null;
    },

    updateDocumentStatus(id, status, error = null) {
      // 只有 failed 状态保留可读错误；重试转回 queued/processing 时会清除旧错误。
      const normalizedStatus = normalizeStatus(status);
      const persistedError = normalizedStatus === 'failed' ? readableError(error) : null;
      const result = updateDocumentStatusStatement.run(normalizedStatus, persistedError, Date.now(), id);
      return result.changes ? mapDocument(selectDocument.get(id)) : null;
    },

    listBugCaseDocuments(scope) {
      return listAllDocuments(scope).filter((document) => document.documentType === 'bug_case');
    },

    getBugCaseDocument(id) {
      const document = mapDocument(selectDocument.get(id));
      return document?.documentType === 'bug_case' ? document : null;
    },

    insertBugCaseDocument(document) {
      // 创建入口固定 candidate + queued；调用方提供的状态字段在这里没有生效机会。
      db.exec('BEGIN');
      try {
        insertDocumentRow({
          ...document,
          documentType: 'bug_case',
          reviewStatus: 'candidate',
          status: 'queued',
          error: null
        }, 'queued', { allowBugCase: true });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const inserted = mapDocument(selectDocument.get(document.id));
      publishQueuedDocuments([inserted.id]);
      return inserted;
    },

    updateBugCaseContent(id, input = {}) {
      const current = mapDocument(selectDocument.get(id));
      if (!current) return null;
      if (current.documentType !== 'bug_case') {
        throw createStoreError(
          'BUG_CASE_NOT_FOUND',
          `BugCase not found: ${id}`,
          404
        );
      }
      const metadata = normalizeMetadata(input.metadata);
      const updatedAt = Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now();
      // 删除派生索引、退回 candidate 和写入新原文属于同一事务。即使随后的 embedding 失败，
      // 旧 citation 也不会继续描述已经被用户修改过的内容。
      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(id);
        deleteDocumentChunks.run(id);
        updateBugCaseContentStatement.run(
          input.name,
          input.content,
          JSON.stringify(metadata),
          updatedAt,
          id
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const updated = mapDocument(selectDocument.get(id));
      publishQueuedDocuments([updated.id]);
      return updated;
    },

    reviewBugCaseDocument(id, input = {}) {
      const current = mapDocument(selectDocument.get(id));
      if (!current || current.documentType !== 'bug_case') return null;
      const reviewStatus = normalizeReviewStatus(input.reviewStatus);
      const metadata = normalizeMetadata(input.metadata);
      const updatedAt = Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now();
      db.exec('BEGIN');
      try {
        updateBugCaseReviewStatement.run(
          reviewStatus,
          JSON.stringify(metadata),
          updatedAt,
          id
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return mapDocument(selectDocument.get(id));
    },

    deleteBugCaseDocument(id) {
      const current = mapDocument(selectDocument.get(id));
      if (!current || current.documentType !== 'bug_case') return 0;
      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(id);
        deleteDocumentChunks.run(id);
        const result = deleteDocumentStatement.run(id);
        db.exec('COMMIT');
        return result.changes;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    promoteBugCaseDocument(id, updatedAt = Date.now()) {
      const current = mapDocument(selectDocument.get(id));
      if (!current || current.documentType !== 'bug_case') return null;
      requireKnowledgeBase(COMMON_BUG_KNOWLEDGE_BASE_ID, ['common_bugs']);

      // chunks_fts 没有 UPDATE 语义，先删后按已移动的权威 chunks 重建；整个过程共享事务，
      // 读者不会看到 document/chunk/FTS 分属两个 scope 的中间状态。
      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(id);
        moveBugCaseDocumentStatement.run(COMMON_BUG_KNOWLEDGE_BASE_ID, updatedAt, id);
        moveBugCaseChunksStatement.run(COMMON_BUG_KNOWLEDGE_BASE_ID, id);
        const chunks = selectChunksForRebuild.all()
          .map(mapChunk)
          .filter((chunk) => chunk.documentId === id);
        for (const chunk of chunks) indexChunk(chunk, COMMON_BUG_KNOWLEDGE_BASE_ID);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return mapDocument(selectDocument.get(id));
    },

    deleteDocument(id, scope) {
      // scope 是调用方指定范围内的一致性/隔离校验：ID 存在但不在指定库中时，
      // 按“未删除”处理。它本身不是身份授权，因为当前存储层没有用户/租户上下文。
      // 显式删 FTS 和 chunk 让逻辑不依赖虚拟表级联，最后才删文档。
      const document = mapDocument(selectDocument.get(id));
      if (!document) return 0;
      if (document.documentType !== 'generic') {
        throw createStoreError(
          'BUG_CASE_REQUIRES_DEDICATED_API',
          'BugCase documents must use the dedicated Bug knowledge API',
          409
        );
      }
      const ids = normalizeScope(scope);
      if (ids && !ids.includes(document.knowledgeBaseId)) return 0;

      db.exec('BEGIN');
      try {
        deleteDocumentFts.run(id);
        deleteDocumentChunks.run(id);
        const result = deleteDocumentStatement.run(id);
        db.exec('COMMIT');
        return result.changes;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    clearDocuments(scope) {
      // 通用“全部”只表示全部 generic 库；系统 Bug 库必须经显式领域动作管理。
      // 这层保护避免旧 API 在新增系统范围后意外变成跨域 destructive operation。
      let ids = normalizeScope(scope);
      if (ids === null) {
        ids = selectKnowledgeBases.all().map((row) => row.id);
      } else {
        for (const id of ids) {
          const knowledgeBase = mapKnowledgeBase(selectKnowledgeBase.get(id));
          if (knowledgeBase && knowledgeBase.kind !== 'generic') {
            throw createStoreError(
              'SYSTEM_KNOWLEDGE_BASE_PROTECTED',
              `Knowledge base ${id} is managed by the Bug knowledge domain`,
              409
            );
          }
        }
      }
      db.exec('BEGIN');
      try {
        const changes = deleteScopedRows({ knowledgeBaseIds: ids });
        db.exec('COMMIT');
        return changes;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    searchChunksByKeyword(query, limit = 20, scope) {
      // 这里只返回 FTS/BM25 候选的 ID、名次和原始分数，不加载正文也不做最终 topK。
      // SQLite bm25 分数越小越好，因此 SQL 升序后再转成从 1 开始的 rank，交给 RRF 与向量名次融合。
      const ftsQuery = buildFtsQuery(query);
      const ids = normalizeScope(scope);
      if (!ftsQuery || ids?.length === 0) return [];

      const conditions = [
        "chunks_fts MATCH ?",
        "documents.status = 'ready'",
        "documents.publication_status = 'published'",
        "(documents.document_type != 'bug_case' OR documents.review_status = 'confirmed')"
      ];
      const params = [ftsQuery];
      if (ids) {
        conditions.push(`chunks_fts.knowledge_base_id IN (${placeholders(ids)})`);
        params.push(...ids);
      }
      params.push(Math.max(1, Number(limit) || 20));

      try {
        return db.prepare(`
          SELECT chunks_fts.chunk_id, bm25(chunks_fts) AS bm25_score
          FROM chunks_fts
          JOIN documents ON documents.id = chunks_fts.document_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY bm25_score ASC
          LIMIT ?
        `).all(...params).map((row, index) => ({
          chunkId: row.chunk_id,
          rank: index + 1,
          bm25Score: row.bm25_score
        }));
      } catch {
        // MATCH 表达式异常时降级为空关键词候选，不应连带中止仍可用的向量检索。
        return [];
      }
    },

    getMetadata(key) {
      return selectMetadata.get(key)?.value;
    },

    setMetadata(key, value) {
      upsertMetadata.run(key, String(value));
    },

    subscribeQueuedDocuments(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('queued document listener must be a function');
      }
      queuedDocumentListeners.add(listener);
      return () => queuedDocumentListeners.delete(listener);
    },

    close() {
      queuedDocumentListeners.clear();
      db.close();
    }
  };
}
