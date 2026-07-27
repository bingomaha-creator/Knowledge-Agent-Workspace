import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 通用长期记忆的 SQLite repository：持久化内容、审查状态、来源、置信度、指纹和向量。
// mcp-server 负责“模型生成候选 → 语义去重 → 用户审查 → 对话召回”编排，
// 本文件只负责数据形状、确定性指纹去重和持久化，不调用模型/embedding，也不做相关性排序。
// 表中保存 JSON 的字段在 repository 边界统一序列化，对外始终返回 camelCase 对象。
const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/pitfalls.sqlite');
// type 描述“记住什么”；旧版的专用 pitfall 现在只是五种记忆之一。
export const MEMORY_TYPES = ['profile', 'preference', 'fact', 'event', 'pitfall'];
// candidate=待用户审查，confirmed=原样确认，corrected=用户修正后确认，rejected=拒绝。
// 只有 confirmed/corrected 可进入对话召回；store 校验枚举，具体状态转换意图由业务层决定。
export const MEMORY_STATUSES = ['candidate', 'confirmed', 'corrected', 'rejected'];
const TYPE_SET = new Set(MEMORY_TYPES);
const STATUS_SET = new Set(MEMORY_STATUSES);
// 这些上限同时保护 SQLite、MCP 返回体和模型上下文，不是 UI 显示截断规则。
const MEMORY_LIMITS = {
  title: 160,
  content: 8000,
  details: 16000,
  sourceConversationId: 160,
  sourceMessageId: 160,
  sourceExcerpt: 12000,
  embeddingDimensions: 8192
};

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function createStoreError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function normalizeType(value, fallback = 'fact') {
  const type = String(value || fallback).trim().toLowerCase();
  if (!TYPE_SET.has(type)) {
    throw createStoreError('INVALID_MEMORY_TYPE', `不支持的记忆类型：${type}`, 400);
  }
  return type;
}

function normalizeStatus(value, fallback = 'candidate') {
  const status = String(value || fallback).trim().toLowerCase();
  if (!STATUS_SET.has(status)) {
    throw createStoreError('INVALID_MEMORY_STATUS', `不支持的记忆状态：${status}`, 400);
  }
  return status;
}

function normalizeConfidence(value, fallback = 0.5) {
  const confidence = Number(value ?? fallback);
  if (!Number.isFinite(confidence)) return fallback;
  return Math.max(0, Math.min(1, confidence));
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().slice(0, MEMORY_LIMITS.sourceMessageId))
    .filter(Boolean))]
    .slice(0, 50);
}

function normalizeSizedString(value, field, maxLength, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) {
    throw createStoreError('INVALID_MEMORY', `记忆${field}不能为空`, 400);
  }
  if (text.length > maxLength) {
    throw createStoreError(
      'MEMORY_TOO_LARGE',
      `记忆${field}超过长度限制`,
      413,
      `${field}最多允许 ${maxLength} 个字符。`
    );
  }
  return text;
}

function normalizeDetails(value) {
  // details 允许各记忆类型保留扩展字段，但必须是可 JSON 序列化的普通对象。
  // 先完整序列化再校验长度，可避免嵌套内容绕过单字段长度限制。
  const details = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let serialized;
  try {
    serialized = JSON.stringify(details);
  } catch {
    throw createStoreError('INVALID_MEMORY_DETAILS', '记忆详情必须可以序列化为 JSON', 400);
  }
  if (serialized.length > MEMORY_LIMITS.details) {
    throw createStoreError(
      'MEMORY_TOO_LARGE',
      '记忆详情超过长度限制',
      413,
      `详情序列化后最多允许 ${MEMORY_LIMITS.details} 个字符。`
    );
  }
  return details;
}

function normalizeEmbedding(value) {
  // 向量可以为 []：embedding 服务不可用时候选仍可靠文本检索工作。
  // 存储层只检查维度上限和有限数，模型维度是否相容由 mcp-server 的 metadata 校验处理。
  if (!Array.isArray(value)) return [];
  if (value.length > MEMORY_LIMITS.embeddingDimensions) {
    throw createStoreError('INVALID_EMBEDDING', '记忆向量维度异常', 400);
  }
  const embedding = value.map(Number);
  if (embedding.some((item) => !Number.isFinite(item))) {
    throw createStoreError('INVALID_EMBEDDING', '记忆向量包含无效数值', 400);
  }
  return embedding;
}

function legacyText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function legacyEmbedding(value) {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, MEMORY_LIMITS.embeddingDimensions)
    .map(Number)
    .filter(Number.isFinite);
}

function legacyDetails(row) {
  // v1 踩坑表没有体积限制；迁移时逐轮缩短字段，优先留下结构化摘要，
  // 最终仍超限则使用空结构降级，不让一条异常旧数据阻断整个服务启动。
  const parsedTags = parseJson(row.tags_json, []);
  let fieldLimit = 2500;
  let tagLimit = 60;
  let tagCount = 30;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const details = {
      symptom: legacyText(row.symptom, fieldLimit),
      cause: legacyText(row.cause, fieldLimit),
      solution: legacyText(row.solution, fieldLimit),
      lesson: legacyText(row.lesson, fieldLimit),
      tags: (Array.isArray(parsedTags) ? parsedTags : [])
        .map((tag) => legacyText(tag, tagLimit))
        .filter(Boolean)
        .slice(0, tagCount)
    };
    if (JSON.stringify(details).length <= MEMORY_LIMITS.details) return details;
    fieldLimit = Math.max(80, Math.floor(fieldLimit / 2));
    tagLimit = Math.max(20, Math.floor(tagLimit / 2));
    tagCount = Math.max(5, Math.floor(tagCount / 2));
  }
  return { symptom: '', cause: '', solution: '', lesson: '', tags: [] };
}

function normalizeFingerprintPart(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#._-]+/gu, '');
}

export function createMemoryFingerprint(memory) {
  // 指纹只解决确定性重复：NFKC/大小写/空白/大部分标点差异不应创建新记忆。
  // 它不能判断“换一种说法的同一件事”；这类语义重复由 memory-utils 的向量相似度处理。
  // 类型、标题、主内容以及 pitfall 的现象/方案组成稳定输入，最终用 SHA-256 做等值查找。
  const details = memory?.details && typeof memory.details === 'object' ? memory.details : {};
  const stable = [
    normalizeType(memory?.type, 'fact'),
    normalizeFingerprintPart(memory?.title),
    normalizeFingerprintPart(memory?.content),
    normalizeFingerprintPart(details.symptom),
    normalizeFingerprintPart(details.solution)
  ].join('|');
  return createHash('sha256').update(stable).digest('hex');
}

function mapMemory(row) {
  // parseJson 失败时使用空对象/数组降级，让历史脏 JSON 不会使整个记忆列表不可用。
  if (!row) return null;
  return {
    id: row.id,
    type: normalizeType(row.type),
    title: row.title,
    content: row.content,
    details: parseJson(row.details_json, {}),
    confidence: normalizeConfidence(row.confidence),
    status: normalizeStatus(row.status),
    sourceConversationId: row.source_conversation_id || '',
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    sourceExcerpt: row.source_excerpt || '',
    fingerprint: row.fingerprint,
    embedding: parseJson(row.embedding_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null
  };
}

function normalizeMemoryInput(input, existing = null) {
  // 新建和部分更新共用同一条规范化管线：更新时未提供字段继承 existing，
  // 显式提供的字段则重新验证。最后总是重算 fingerprint，防止编辑后指纹过期。
  const type = normalizeType(input.type, existing?.type || 'fact');
  const title = normalizeSizedString(
    input.title ?? existing?.title,
    '标题',
    MEMORY_LIMITS.title,
    { required: true }
  );
  const content = normalizeSizedString(
    input.content ?? existing?.content,
    '内容',
    MEMORY_LIMITS.content,
    { required: true }
  );

  const status = normalizeStatus(input.status, existing?.status || 'candidate');
  const details = normalizeDetails(
    Object.hasOwn(input, 'details') ? input.details : existing?.details || {}
  );
  const sourceConversationId = Object.hasOwn(input, 'sourceConversationId')
    ? normalizeSizedString(
        input.sourceConversationId,
        '来源会话 ID',
        MEMORY_LIMITS.sourceConversationId
      )
    : existing?.sourceConversationId || '';
  // 历史迁移数据可能比新上限更长；更新状态时原样保留，只有新写入来源受限。
  const sourceExcerpt = Object.hasOwn(input, 'sourceExcerpt')
    ? normalizeSizedString(input.sourceExcerpt, '来源片段', MEMORY_LIMITS.sourceExcerpt)
    : existing?.sourceExcerpt || '';
  const normalized = {
    id: String(input.id || existing?.id || `memory-${randomUUID()}`),
    type,
    title,
    content,
    details,
    confidence: normalizeConfidence(input.confidence, existing?.confidence ?? 0.5),
    status,
    sourceConversationId,
    sourceMessageIds: normalizeStringArray(
      input.sourceMessageIds ?? existing?.sourceMessageIds ?? []
    ),
    sourceExcerpt,
    embedding: normalizeEmbedding(
      Object.hasOwn(input, 'embedding') ? input.embedding : existing?.embedding || []
    ),
    createdAt: Number(input.createdAt || existing?.createdAt || Date.now()),
    updatedAt: Number(input.updatedAt || Date.now()),
    confirmedAt:
      // 被拒绝或重新打回候选后清除确认时间；已确认/已纠正则保留首次确认时间。
      status === 'confirmed' || status === 'corrected'
        ? Number(input.confirmedAt || existing?.confirmedAt || Date.now())
        : null
  };
  normalized.fingerprint = createMemoryFingerprint(normalized);
  return normalized;
}

export function createMemoryStore(dbPath = DEFAULT_DB_PATH) {
  // 默认路径沿用 pitfalls.sqlite，是为了原地升级旧踩坑数据，而不是将新记忆限制为 pitfall。
  // WAL 提供读写并行；建表是幂等的。下方旧表数据迁移有显式事务，
  // 日常单条 insert/update/delete 则使用 SQLite 每条语句的自动事务。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('profile', 'preference', 'fact', 'event', 'pitfall')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      details_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'corrected', 'rejected')),
      source_conversation_id TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      source_excerpt TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memories_status_updated
      ON memories(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_type_updated
      ON memories(type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_fingerprint
      ON memories(fingerprint);

    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertStatement = db.prepare(`
    INSERT INTO memories (
      id, type, title, content, details_json, confidence, status,
      source_conversation_id, source_message_ids_json, source_excerpt,
      fingerprint, embedding_json, created_at, updated_at, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatement = db.prepare(`
    UPDATE memories SET
      type = ?, title = ?, content = ?, details_json = ?, confidence = ?, status = ?,
      source_conversation_id = ?, source_message_ids_json = ?, source_excerpt = ?,
      fingerprint = ?, embedding_json = ?, updated_at = ?, confirmed_at = ?
    WHERE id = ?
  `);
  const selectById = db.prepare('SELECT * FROM memories WHERE id = ?');
  const deleteById = db.prepare('DELETE FROM memories WHERE id = ?');
  const selectMetadata = db.prepare('SELECT value FROM memory_metadata WHERE key = ?');
  const upsertMetadata = db.prepare(`
    INSERT INTO memory_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
  const migrationKey = 'legacy_pitfall_migration_v1_complete';
  const migrationComplete = selectMetadata.get(migrationKey)?.value === '1';
  // 旧表只迁移一次：metadata 标志与 user_version 双重防护。否则用户删除
  // 迁移后的记录，再次启动时它会从旧表“复活”。整批记忆、旧 metadata、
  // 完成标志和 schema 版本位于同一事务，任一行失败都回滚。
  if (tableExists(db, 'pitfall_memories') && schemaVersion < 2 && !migrationComplete) {
    const oldRows = db.prepare('SELECT * FROM pitfall_memories').all();
    db.exec('BEGIN');
    try {
      for (const row of oldRows) {
        if (selectById.get(row.id)) continue;
        // 旧表没有长度约束；迁移时保留可用摘要并安全截断，不能让单条脏数据阻止 MCP 启动。
        const details = legacyDetails(row);
        const content = [
          row.symptom ? `现象：${row.symptom}` : '',
          row.cause ? `根因：${row.cause}` : '',
          row.solution ? `方案：${row.solution}` : '',
          row.lesson ? `经验：${row.lesson}` : ''
        ].filter(Boolean).join('\n').slice(0, MEMORY_LIMITS.content);
        const memory = normalizeMemoryInput({
          id: row.id,
          type: 'pitfall',
          title: legacyText(row.title, MEMORY_LIMITS.title) || '未命名踩坑',
          content: content || legacyText(row.title, MEMORY_LIMITS.content) || '旧版踩坑记录',
          details,
          confidence: 0.9,
          status: 'confirmed',
          sourceExcerpt: String(row.source_messages || '').slice(0, MEMORY_LIMITS.sourceExcerpt),
          embedding: legacyEmbedding(row.embedding_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          confirmedAt: row.updated_at
        });
        insertStatement.run(
          memory.id, memory.type, memory.title, memory.content,
          JSON.stringify(memory.details), memory.confidence, memory.status,
          memory.sourceConversationId, JSON.stringify(memory.sourceMessageIds),
          memory.sourceExcerpt, memory.fingerprint, JSON.stringify(memory.embedding),
          memory.createdAt, memory.updatedAt, memory.confirmedAt
        );
      }

      if (tableExists(db, 'pitfall_metadata')) {
        for (const row of db.prepare('SELECT key, value FROM pitfall_metadata').all()) {
          upsertMetadata.run(row.key, row.value);
        }
      }
      upsertMetadata.run(migrationKey, '1');
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  } else {
    upsertMetadata.run(migrationKey, '1');
    db.exec('PRAGMA user_version = 2');
  }

  function insertMemory(input) {
    // 核心去重不变量：同一指纹在 candidate/confirmed/corrected 中只保留一条活跃记忆；
    // rejected 不阻止用户未来重新提出相同事实。这是单进程同步 repository 的应用层校验；
    // 更宽泛的语义去重必须在调用 insertMemory 之前完成。
    const memory = normalizeMemoryInput(input);
    const duplicate = findByFingerprint(memory.fingerprint);
    if (duplicate) {
      throw createStoreError(
        'MEMORY_DUPLICATE',
        '已存在相同或高度相似的记忆',
        409,
        duplicate.id
      );
    }
    insertStatement.run(
      memory.id, memory.type, memory.title, memory.content,
      JSON.stringify(memory.details), memory.confidence, memory.status,
      memory.sourceConversationId, JSON.stringify(memory.sourceMessageIds),
      memory.sourceExcerpt, memory.fingerprint, JSON.stringify(memory.embedding),
      memory.createdAt, memory.updatedAt, memory.confirmedAt
    );
    return mapMemory(selectById.get(memory.id));
  }

  function buildMemoryFilter(filters = {}) {
    // 空 statuses/types 是“明确不匹配任何记忆”，不是取全部；empty 会让上层直接返回。
    // LIKE 查询会转义 %/_/\\，使用户输入始终按字面子串匹配，不意外变成通配符。
    const clauses = [];
    const params = [];
    if (filters.statuses !== undefined) {
      const statuses = (Array.isArray(filters.statuses) ? filters.statuses : [filters.statuses])
        .map((status) => normalizeStatus(status));
      if (!statuses.length) return { empty: true, where: '', params: [] };
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.types !== undefined) {
      const types = (Array.isArray(filters.types) ? filters.types : [filters.types])
        .map((type) => normalizeType(type));
      if (!types.length) return { empty: true, where: '', params: [] };
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (filters.query) {
      const escaped = String(filters.query).trim().replace(/[\\%_]/g, '\\$&');
      const query = `%${escaped}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR source_excerpt LIKE ? ESCAPE '\\')");
      params.push(query, query, query);
    }
    return {
      empty: false,
      where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    };
  }

  function listMemories(filters = {}) {
    const { empty, where, params } = buildMemoryFilter(filters);
    if (empty) return [];
    const limit = Math.max(1, Math.min(Number(filters.limit) || 1000, 5000));
    const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
    return db.prepare(`
      SELECT * FROM memories ${where}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `)
      .all(...params, limit, offset)
      .map(mapMemory);
  }

  function countMemories(filters = {}) {
    const { empty, where, params } = buildMemoryFilter(filters);
    if (empty) return 0;
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).get(...params)?.count) || 0;
  }

  function findByFingerprint(fingerprint, statuses = ['candidate', 'confirmed', 'corrected']) {
    // 默认忽略 rejected 是刻意的；调用者也可显式传 statuses 检查其他审查态。
    const normalizedStatuses = statuses.map((status) => normalizeStatus(status));
    if (!normalizedStatuses.length) return null;
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    return mapMemory(
      db.prepare(`
        SELECT * FROM memories
        WHERE fingerprint = ? AND status IN (${placeholders})
        ORDER BY updated_at DESC LIMIT 1
      `).get(fingerprint, ...normalizedStatuses)
    );
  }

  return {
    listMemories,
    countMemories,
    listAllMemories() {
      return db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all().map(mapMemory);
    },
    listRetrievableMemories() {
      // 这是持久化层的最后安全门：模型生成的 candidate 与用户拒绝的内容永远不可注入对话。
      return db.prepare(`
        SELECT * FROM memories
        WHERE status IN ('confirmed', 'corrected')
        ORDER BY updated_at DESC
      `).all().map(mapMemory);
    },
    getMemory(id) {
      return mapMemory(selectById.get(id));
    },
    insertMemory,
    updateMemory(id, patch) {
      // 确认、纠正、拒绝与普通编辑都走同一入口；规范化后再做指纹冲突检查。
      // 查到的 duplicate 若就是当前 id 属于合法原地更新，只有冲突到另一条记忆才拒绝。
      const existing = mapMemory(selectById.get(id));
      if (!existing) {
        throw createStoreError('MEMORY_NOT_FOUND', '记忆不存在', 404);
      }
      const memory = normalizeMemoryInput({ ...patch, id }, existing);
      const duplicate = findByFingerprint(memory.fingerprint);
      if (duplicate && duplicate.id !== id) {
        throw createStoreError('MEMORY_DUPLICATE', '已存在相同或高度相似的记忆', 409, duplicate.id);
      }
      updateStatement.run(
        memory.type, memory.title, memory.content, JSON.stringify(memory.details),
        memory.confidence, memory.status, memory.sourceConversationId,
        JSON.stringify(memory.sourceMessageIds), memory.sourceExcerpt,
        memory.fingerprint, JSON.stringify(memory.embedding), memory.updatedAt,
        memory.confirmedAt, id
      );
      return mapMemory(selectById.get(id));
    },
    deleteMemory(id) {
      const result = deleteById.run(id);
      if (!result.changes) throw createStoreError('MEMORY_NOT_FOUND', '记忆不存在', 404);
      return { ok: true, id };
    },
    findByFingerprint,
    getMetadata(key) {
      return selectMetadata.get(key)?.value;
    },
    setMetadata(key, value) {
      upsertMetadata.run(key, String(value));
    },
    close() {
      db.close();
    }
  };
}
