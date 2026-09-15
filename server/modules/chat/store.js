/**
 * Chat 会话与消息的 SQLite 持久化 Adapter。
 *
 * 它拥有会话配置、消息顺序、发送幂等和消息状态转换；不调用模型、不发送 SSE，
 * 也不决定 Orchestrator 应该选取哪些上下文。首次发送需要原子创建会话和一轮
 * user/assistant 消息，因此由 startTurn 统一隐藏 sequence 分配和事务细节。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/chat.sqlite');
const DEFAULT_MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGE_SIZE = 100;
const MAX_SESSION_LIST_SIZE = 500;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_SESSION_TITLE_LENGTH = 24;
const MAX_ID_LENGTH = 160;
const ASSISTANT_STATUSES = new Set([
  'streaming',
  'done',
  'error',
  'cancelled',
  'interrupted'
]);
const TERMINAL_ASSISTANT_STATUSES = new Set([
  'done',
  'error',
  'cancelled',
  'interrupted'
]);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createStoreError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function normalizeId(value, field, { required = true } = {}) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (required && !id) {
    throw createStoreError('CHAT_INVALID_INPUT', `${field}不能为空`, 400);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw createStoreError(
      'CHAT_INVALID_INPUT',
      `${field}过长`,
      400,
      `${field}最多允许 ${MAX_ID_LENGTH} 个字符。`
    );
  }
  return id;
}

function normalizeContent(value) {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!content) {
    throw createStoreError('CHAT_EMPTY_MESSAGE', '消息内容不能为空', 400);
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw createStoreError(
      'CHAT_MESSAGE_TOO_LARGE',
      '消息内容超过长度限制',
      413,
      `单条消息最多允许 ${MAX_CONTENT_LENGTH} 个字符。`
    );
  }
  return content;
}

function normalizeKnowledgeBaseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => id.slice(0, MAX_ID_LENGTH))
  )].slice(0, 20);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function serializeJson(value, fallback) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    presetId: row.preset_id,
    ragEnabled: Boolean(row.rag_enabled),
    knowledgeBaseIds: normalizeKnowledgeBaseIds(
      parseJson(row.knowledge_base_ids_json, [])
    ),
    messageCount: Number(row.message_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    sequenceNo: row.sequence_no,
    requestId: row.request_id,
    role: row.role,
    content: row.content,
    status: row.status,
    citations: normalizeArray(parseJson(row.citations_json, [])),
    tools: normalizeArray(parseJson(row.tools_json, [])),
    memoryCandidate: normalizeObject(parseJson(row.memory_candidate_json, null)),
    runId: row.run_id || null,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createChatStore(dbPath = DEFAULT_DB_PATH, options = {}) {
  const now = options.now || Date.now;
  const createId = options.createId || ((prefix) => `${prefix}-${randomUUID()}`);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      rag_enabled INTEGER NOT NULL CHECK (rag_enabled IN (0, 1)),
      knowledge_base_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      sequence_no INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        (role = 'user' AND status = 'done') OR
        (role = 'assistant' AND status IN (
          'streaming', 'done', 'error', 'cancelled', 'interrupted'
        ))
      ),
      citations_json TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      memory_candidate_json TEXT NOT NULL,
      run_id TEXT,
      error_code TEXT NOT NULL,
      error_message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, sequence_no),
      UNIQUE(request_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
      ON chat_sessions(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_sequence
      ON chat_messages(session_id, sequence_no DESC);
  `);

  const sessionProjection = `
    SELECT sessions.*,
      (SELECT COUNT(*) FROM chat_messages messages WHERE messages.session_id = sessions.id)
        AS message_count
    FROM chat_sessions sessions
  `;
  const selectSession = db.prepare(`${sessionProjection} WHERE sessions.id = ?`);
  const selectMessage = db.prepare('SELECT * FROM chat_messages WHERE id = ?');
  const selectUserByRequest = db.prepare(`
    SELECT * FROM chat_messages WHERE request_id = ? AND role = 'user'
  `);
  const selectAssistantByRequest = db.prepare(`
    SELECT * FROM chat_messages WHERE request_id = ? AND role = 'assistant'
  `);

  function getSession(id) {
    const normalizedId = normalizeId(id, '会话 ID');
    return mapSession(selectSession.get(normalizedId));
  }

  function requireSession(id) {
    const session = getSession(id);
    if (!session) {
      throw createStoreError('CHAT_SESSION_NOT_FOUND', '会话不存在', 404);
    }
    return session;
  }

  function getMessage(id) {
    const normalizedId = normalizeId(id, '消息 ID');
    return mapMessage(selectMessage.get(normalizedId));
  }

  function recoverInterrupted() {
    const timestamp = now();
    const affectedSessions = db.prepare(`
      SELECT DISTINCT session_id FROM chat_messages WHERE status = 'streaming'
    `).all().map((row) => row.session_id);
    const result = db.prepare(`
      UPDATE chat_messages
      SET status = 'interrupted',
          error_code = 'PROCESS_RESTARTED',
          error_message = '服务进程重启，本次回答未正常结束。',
          updated_at = ?
      WHERE status = 'streaming'
    `).run(timestamp);
    if (result.changes) {
      const updateSession = db.prepare(`
        UPDATE chat_sessions SET updated_at = ? WHERE id = ?
      `);
      for (const sessionId of affectedSessions) {
        updateSession.run(timestamp, sessionId);
      }
    }
    return Number(result.changes) || 0;
  }

  // running/streaming 只代表当前进程仍持有执行权，因此任何查询前先收敛旧状态。
  recoverInterrupted();

  function listSessions({ limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_SESSION_LIST_SIZE));
    return db.prepare(`
      ${sessionProjection}
      ORDER BY sessions.updated_at DESC, sessions.id DESC
      LIMIT ?
    `).all(boundedLimit).map(mapSession);
  }

  function listMessages(sessionId, { before, limit = DEFAULT_MESSAGE_PAGE_SIZE } = {}) {
    const session = requireSession(sessionId);
    const boundedLimit = Math.max(
      1,
      Math.min(Number(limit) || DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE)
    );
    const beforeSequence = Number(before);
    const rows = Number.isInteger(beforeSequence) && beforeSequence > 0
      ? db.prepare(`
          SELECT * FROM chat_messages
          WHERE session_id = ? AND sequence_no < ?
          ORDER BY sequence_no DESC
          LIMIT ?
        `).all(session.id, beforeSequence, boundedLimit + 1)
      : db.prepare(`
          SELECT * FROM chat_messages
          WHERE session_id = ?
          ORDER BY sequence_no DESC
          LIMIT ?
        `).all(session.id, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const messages = rows.slice(0, boundedLimit).map(mapMessage).reverse();
    return {
      messages,
      nextCursor: hasMore && messages.length ? messages[0].sequenceNo : null
    };
  }

  function existingTurn(requestId, expectedSessionId = '') {
    const userMessage = mapMessage(selectUserByRequest.get(requestId));
    if (!userMessage) return null;
    if (expectedSessionId && userMessage.sessionId !== expectedSessionId) {
      throw createStoreError(
        'CHAT_REQUEST_CONFLICT',
        '该请求 ID 已用于其他会话',
        409
      );
    }
    const assistantMessage = mapMessage(selectAssistantByRequest.get(requestId));
    if (!assistantMessage || assistantMessage.sessionId !== userMessage.sessionId) {
      throw createStoreError(
        'CHAT_TURN_INCOMPLETE',
        '持久化的消息轮次不完整',
        500
      );
    }
    return {
      reused: true,
      session: requireSession(userMessage.sessionId),
      userMessage,
      assistantMessage
    };
  }

  function startTurn(input = {}) {
    const requestId = normalizeId(input.requestId, '请求 ID');
    const requestedSessionId = normalizeId(input.sessionId, '会话 ID', { required: false });
    const content = normalizeContent(input.content);
    const duplicate = existingTurn(requestId, requestedSessionId);
    if (duplicate) return duplicate;

    db.exec('BEGIN IMMEDIATE');
    try {
      // BEGIN 后再次检查，防止两个并发请求在事务外同时判断为不存在。
      const racedDuplicate = existingTurn(requestId, requestedSessionId);
      if (racedDuplicate) {
        db.exec('COMMIT');
        return racedDuplicate;
      }

      const timestamp = now();
      let sessionId = requestedSessionId;
      if (sessionId) {
        requireSession(sessionId);
      } else {
        sessionId = normalizeId(createId('session'), '会话 ID');
        const presetId = normalizeId(input.presetId || 'general', 'Preset ID');
        const knowledgeBaseIds = normalizeKnowledgeBaseIds(input.knowledgeBaseIds);
        db.prepare(`
          INSERT INTO chat_sessions (
            id, title, preset_id, rag_enabled, knowledge_base_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          content.slice(0, MAX_SESSION_TITLE_LENGTH),
          presetId,
          input.ragEnabled === false ? 0 : 1,
          serializeJson(knowledgeBaseIds, []),
          timestamp,
          timestamp
        );
      }

      const nextSequence = Number(db.prepare(`
        SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
        FROM chat_messages WHERE session_id = ?
      `).get(sessionId).next_sequence);
      const userMessageId = normalizeId(createId('user'), '用户消息 ID');
      const assistantMessageId = normalizeId(createId('assistant'), 'assistant 消息 ID');
      const insertMessage = db.prepare(`
        INSERT INTO chat_messages (
          id, session_id, sequence_no, request_id, role, content, status,
          citations_json, tools_json, memory_candidate_json, run_id,
          error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'null', NULL, '', '', ?, ?)
      `);
      insertMessage.run(
        userMessageId,
        sessionId,
        nextSequence,
        requestId,
        'user',
        content,
        'done',
        timestamp,
        timestamp
      );
      insertMessage.run(
        assistantMessageId,
        sessionId,
        nextSequence + 1,
        requestId,
        'assistant',
        '',
        'streaming',
        timestamp,
        timestamp
      );
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?')
        .run(timestamp, sessionId);
      db.exec('COMMIT');
      return {
        reused: false,
        session: requireSession(sessionId),
        userMessage: getMessage(userMessageId),
        assistantMessage: getMessage(assistantMessageId)
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function updateSession(id, patch = {}) {
    const existing = requireSession(id);
    const presetId = Object.hasOwn(patch, 'presetId')
      ? normalizeId(patch.presetId, 'Preset ID')
      : existing.presetId;
    const ragEnabled = Object.hasOwn(patch, 'ragEnabled')
      ? Boolean(patch.ragEnabled)
      : existing.ragEnabled;
    const knowledgeBaseIds = Object.hasOwn(patch, 'knowledgeBaseIds')
      ? normalizeKnowledgeBaseIds(patch.knowledgeBaseIds)
      : existing.knowledgeBaseIds;
    const timestamp = now();
    db.prepare(`
      UPDATE chat_sessions
      SET preset_id = ?, rag_enabled = ?, knowledge_base_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      presetId,
      ragEnabled ? 1 : 0,
      serializeJson(knowledgeBaseIds, []),
      timestamp,
      existing.id
    );
    return requireSession(existing.id);
  }

  function updateAssistantMessage(id, patch = {}) {
    const existing = getMessage(id);
    if (!existing) {
      throw createStoreError('CHAT_MESSAGE_NOT_FOUND', '消息不存在', 404);
    }
    if (existing.role !== 'assistant') {
      throw createStoreError('CHAT_INVALID_MESSAGE_ROLE', '只能更新 assistant 消息', 409);
    }
    const nextStatus = patch.status || existing.status;
    if (!ASSISTANT_STATUSES.has(nextStatus)) {
      throw createStoreError('CHAT_INVALID_MESSAGE_STATUS', 'assistant 消息状态无效', 400);
    }
    if (TERMINAL_ASSISTANT_STATUSES.has(existing.status) && nextStatus !== existing.status) {
      throw createStoreError('CHAT_MESSAGE_TERMINAL', '终态消息不能再次转换状态', 409);
    }
    const content = Object.hasOwn(patch, 'content')
      ? String(patch.content ?? '').slice(0, MAX_CONTENT_LENGTH)
      : existing.content;
    const citations = Object.hasOwn(patch, 'citations')
      ? normalizeArray(patch.citations)
      : existing.citations;
    const tools = Object.hasOwn(patch, 'tools')
      ? normalizeArray(patch.tools)
      : existing.tools;
    const memoryCandidate = Object.hasOwn(patch, 'memoryCandidate')
      ? normalizeObject(patch.memoryCandidate)
      : existing.memoryCandidate;
    const runId = Object.hasOwn(patch, 'runId')
      ? normalizeId(patch.runId, 'Run ID', { required: false }) || null
      : existing.runId;
    const errorCode = Object.hasOwn(patch, 'errorCode')
      ? String(patch.errorCode || '').slice(0, MAX_ID_LENGTH)
      : existing.errorCode;
    const errorMessage = Object.hasOwn(patch, 'errorMessage')
      ? String(patch.errorMessage || '').slice(0, 2_000)
      : existing.errorMessage;
    const timestamp = now();
    db.prepare(`
      UPDATE chat_messages
      SET content = ?, status = ?, citations_json = ?, tools_json = ?,
          memory_candidate_json = ?, run_id = ?, error_code = ?, error_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      content,
      nextStatus,
      serializeJson(citations, []),
      serializeJson(tools, []),
      serializeJson(memoryCandidate, null),
      runId,
      errorCode,
      errorMessage,
      timestamp,
      existing.id
    );
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?')
      .run(timestamp, existing.sessionId);
    return getMessage(existing.id);
  }

  function deleteSession(id) {
    const normalizedId = normalizeId(id, '会话 ID');
    const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(normalizedId);
    return Boolean(result.changes);
  }

  function syncMemoryCandidateProjection(memoryId, memory) {
    const normalizedMemoryId = normalizeId(memoryId, 'Memory ID');
    const rows = db.prepare(`
      SELECT id, memory_candidate_json
      FROM chat_messages
      WHERE role = 'assistant' AND memory_candidate_json != 'null'
    `).all();
    const matches = rows.filter((row) => (
      normalizeObject(parseJson(row.memory_candidate_json, null))?.id === normalizedMemoryId
    ));
    if (!matches.length) return 0;

    const updateProjection = db.prepare(`
      UPDATE chat_messages SET memory_candidate_json = ? WHERE id = ?
    `);
    db.exec('BEGIN');
    try {
      for (const row of matches) {
        updateProjection.run(serializeJson(memory ? normalizeObject(memory) : null, null), row.id);
      }
      db.exec('COMMIT');
      return matches.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    startTurn,
    listSessions,
    getSession,
    listMessages,
    getMessage,
    updateSession,
    updateAssistantMessage,
    syncMemoryCandidateProjection,
    deleteSession,
    recoverInterrupted,
    close() {
      db.close();
    }
  };
}
