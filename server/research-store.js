/**
 * 异步研究任务的 SQLite 持久化层与状态机。
 *
 * 职责：迁移旧库、校验状态转换、原子 claim 执行权，并保存每一阶段的 artifacts、
 * 报告与引用。它不执行研究步骤，也不管理内存队列或 AbortController；这些属于
 * research-worker.js。把状态机放在存储层，可以让 HTTP、Worker 和重启恢复共享
 * 同一组不变量，而不是各自随意改 status 字符串。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  RESEARCH_RESULT_QUALITY_VALUES,
  RESEARCH_SEARCH_MODE_VALUES,
  RESEARCH_STAGE_VALUES,
  RESEARCH_STATUS_VALUES,
  RESEARCH_WEB_SEARCH_STATUS_VALUES
} from './research-domain.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/research.sqlite');

const RESEARCH_STATUSES = new Set(RESEARCH_STATUS_VALUES);
const RESEARCH_STAGES = new Set(RESEARCH_STAGE_VALUES);
const SEARCH_MODES = new Set(RESEARCH_SEARCH_MODE_VALUES);
const WEB_SEARCH_STATUSES = new Set(RESEARCH_WEB_SEARCH_STATUS_VALUES);
const RESULT_QUALITIES = new Set(RESEARCH_RESULT_QUALITY_VALUES);

/*
 * 合法生命周期：
 * queued -> running -> completed
 *                  └-> failed    -> queued（重试）
 * queued/running    -> cancelled -> queued（重试）
 * completed 不可再进入其他状态，防止已交付报告被误执行。
 */
const STATUS_TRANSITIONS = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  failed: new Set(['queued']),
  cancelled: new Set(['queued']),
  completed: new Set()
};

// JSON 附属字段损坏时回退为空结构，让历史任务仍可打开并由后续阶段重新生成。
function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Store 错误附带稳定 code/status，供 HTTP 层转换成可读的 4xx 响应。
function createStoreError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeSearchMode(value) {
  // both 是早期客户端使用过的兼容别名，持久化时统一为 hybrid。
  const normalized = value === 'both' ? 'hybrid' : String(value || 'local').trim();
  return SEARCH_MODES.has(normalized) ? normalized : 'local';
}

function normalizeWebSearchStatus(value, searchMode = 'local') {
  const fallback = searchMode === 'local' ? 'not_requested' : 'pending';
  const normalized = String(value || fallback).trim();
  return WEB_SEARCH_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeResultQuality(value) {
  const normalized = String(value || 'pending').trim();
  return RESULT_QUALITIES.has(normalized) ? normalized : 'pending';
}

function normalizeLimitations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const code = String(item.code || '').trim().slice(0, 120);
    const message = String(item.message || '').trim().slice(0, 500);
    if (!code || !message || seen.has(code)) return [];
    seen.add(code);
    return [{ code, message }];
  }).slice(0, 20);
}

function normalizeKnowledgeBaseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => id.slice(0, 160))
  )].slice(0, 20);
}

function normalizeArtifacts(value) {
  // artifacts 是阶段产物快照，结构由 Worker 演进；Store 只保证最外层是普通对象。
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeCitations(value) {
  return Array.isArray(value) ? value : [];
}

function boundedText(value, length) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, length) : '';
}

function normalizeContinuationContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parent = value.parent && typeof value.parent === 'object' ? value.parent : {};
  const citations = Array.isArray(value.citations) ? value.citations : [];
  const normalized = {
    originQuestion: boundedText(value.originQuestion, 800),
    parent: {
      taskId: boundedText(parent.taskId, 120),
      question: boundedText(parent.question, 800),
      reportExcerpt: boundedText(parent.reportExcerpt, 1_800),
      resultQuality: boundedText(parent.resultQuality, 40),
      limitations: normalizeLimitations(parent.limitations)
    },
    citations: citations.flatMap((citation) => {
      if (!citation || typeof citation !== 'object') return [];
      const title = boundedText(citation.title, 240);
      const snippet = boundedText(citation.snippet, 800);
      if (!title && !snippet) return [];
      return [{
        id: boundedText(citation.id, 200),
        title: title || '未命名资料',
        snippet,
        url: boundedText(citation.url, 2_048),
        kind: citation.kind === 'web' ? 'web' : 'local',
        sourceKind: boundedText(citation.sourceKind, 80),
        originTaskId: boundedText(citation.originTaskId, 120)
      }];
    }).slice(0, 6)
  };
  return normalized.originQuestion || normalized.parent.taskId ? normalized : null;
}

function mapTask(row) {
  // 映射也是读取边界：旧库中的非法枚举不会直接泄漏给前端或 Worker。
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    status: RESEARCH_STATUSES.has(row.status) ? row.status : 'failed',
    stage: RESEARCH_STAGES.has(row.stage) ? row.stage : 'planning',
    progress: Number(row.progress) || 0,
    error: row.error || '',
    report: row.report || '',
    citations: normalizeCitations(parseJson(row.citations_json, [])),
    searchMode: normalizeSearchMode(row.search_mode),
    webSearchStatus: normalizeWebSearchStatus(row.web_search_status, row.search_mode),
    resultQuality: normalizeResultQuality(row.result_quality),
    limitations: normalizeLimitations(parseJson(row.limitations_json, [])),
    failedStage: RESEARCH_STAGES.has(row.failed_stage) ? row.failed_stage : '',
    attempt: Math.max(0, Number(row.attempt) || 0),
    cancelRequested: Boolean(row.cancel_requested),
    sessionId: row.session_id || row.id,
    parentTaskId: row.parent_task_id || '',
    turnIndex: Math.max(1, Number(row.turn_index) || 1),
    continuationContext: normalizeContinuationContext(parseJson(row.continuation_context_json, null)),
    knowledgeBaseIds: normalizeKnowledgeBaseIds(parseJson(row.knowledge_base_ids_json, [])),
    artifacts: normalizeArtifacts(parseJson(row.artifacts_json, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null
  };
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function migrateDatabase(db) {
  // 先用最新结构创建新库，再按列增量 ALTER 旧库；不删除或重建用户已有任务。
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_tasks (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress INTEGER NOT NULL,
      error TEXT NOT NULL,
      report TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      search_mode TEXT NOT NULL DEFAULT 'local',
      web_search_status TEXT NOT NULL DEFAULT 'not_requested',
      result_quality TEXT NOT NULL DEFAULT 'pending'
        CHECK (result_quality IN ('pending', 'sufficient', 'limited', 'insufficient')),
      limitations_json TEXT NOT NULL DEFAULT '[]',
      failed_stage TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL DEFAULT '',
      parent_task_id TEXT NOT NULL DEFAULT '',
      turn_index INTEGER NOT NULL DEFAULT 1,
      continuation_context_json TEXT NOT NULL DEFAULT '{}',
      knowledge_base_ids_json TEXT NOT NULL DEFAULT '[]',
      artifacts_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )
  `);

  // Phase 1 Harness shadow（Spec research-harness §8/§9）：完成契约检查、RunBudget
  // 计数与错误分类均为独立 side table，只增不改；不进入任务状态机，也不改变
  // completed/failed 语义。artifact_refs_json 为二次修正的增量列（旧库 ALTER 补齐）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_contract_checks (
      run_id TEXT NOT NULL,
      check_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      passed INTEGER,
      threshold REAL,
      verifier TEXT NOT NULL DEFAULT 'completion-policy',
      verifier_version INTEGER NOT NULL DEFAULT 2,
      observed_json TEXT NOT NULL DEFAULT '{}',
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      explanation TEXT NOT NULL DEFAULT '',
      not_evaluable_cause TEXT,
      mode TEXT NOT NULL DEFAULT 'shadow',
      next_action TEXT NOT NULL DEFAULT 'complete',
      next_action_reason TEXT NOT NULL DEFAULT '',
      verdict_passed INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, check_id)
    );

    CREATE TABLE IF NOT EXISTS research_run_budget (
      run_id TEXT PRIMARY KEY,
      wall_time_ms INTEGER NOT NULL DEFAULT 0,
      web_search_calls INTEGER NOT NULL DEFAULT 0,
      targeted_replans_used INTEGER NOT NULL DEFAULT 0,
      targeted_replans_limit INTEGER NOT NULL DEFAULT 1,
      report_repairs_used INTEGER NOT NULL DEFAULT 0,
      report_repairs_limit INTEGER NOT NULL DEFAULT 1,
      adapter_retries_used INTEGER NOT NULL DEFAULT 0,
      adapter_retries_limit INTEGER NOT NULL DEFAULT 3,
      writer_input_tokens INTEGER NOT NULL DEFAULT 0,
      writer_output_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_run_errors (
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      retryable INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_research_run_errors_run
      ON research_run_errors(run_id, created_at);

    CREATE TABLE IF NOT EXISTS research_evidence_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'source_content',
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_research_evidence_artifacts_run
      ON research_evidence_artifacts(run_id);

    CREATE TABLE IF NOT EXISTS research_evidence_ledger (
      run_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      source_channel TEXT NOT NULL DEFAULT '',
      canonical_source_id TEXT NOT NULL DEFAULT '',
      canonical_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      provenance_before TEXT NOT NULL DEFAULT 'unknown',
      provenance_after TEXT NOT NULL DEFAULT 'unknown',
      provenance_transition_json TEXT NOT NULL DEFAULT 'null',
      subquestion_id TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      reader_kind TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      truncated INTEGER NOT NULL DEFAULT 0,
      artifact_id TEXT NOT NULL DEFAULT '',
      screening_status TEXT NOT NULL DEFAULT 'pending',
      screening_reason TEXT NOT NULL DEFAULT '',
      reading_status TEXT NOT NULL DEFAULT 'pending',
      reading_reason TEXT NOT NULL DEFAULT '',
      extraction_status TEXT NOT NULL DEFAULT 'not_selected',
      citation_status TEXT NOT NULL DEFAULT 'not_cited',
      citation_id TEXT NOT NULL DEFAULT '',
      ledger_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, evidence_id)
    );

    CREATE INDEX IF NOT EXISTS idx_research_evidence_ledger_run
      ON research_evidence_ledger(run_id);

    CREATE TABLE IF NOT EXISTS research_evidence_ledger_diffs (
      run_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'shadow',
      ledger_version INTEGER NOT NULL DEFAULT 1,
      diff_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);

  const checkColumns = tableColumns(db, 'research_contract_checks');
  if (!checkColumns.has('artifact_refs_json')) {
    db.exec("ALTER TABLE research_contract_checks ADD COLUMN artifact_refs_json TEXT NOT NULL DEFAULT '[]'");
  }

  const ledgerColumns = tableColumns(db, 'research_evidence_ledger');
  const ledgerAdditions = [
    ['reader_attestation', "TEXT NOT NULL DEFAULT ''"],
    ['reader_attestation_reason', "TEXT NOT NULL DEFAULT ''"],
    ['extraction_reason', "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [name, definition] of ledgerAdditions) {
    if (!ledgerColumns.has(name)) {
      db.exec(`ALTER TABLE research_evidence_ledger ADD COLUMN ${name} ${definition}`);
    }
  }

  const columns = tableColumns(db, 'research_tasks');
  const addsResultQuality = !columns.has('result_quality');
  const addsLimitations = !columns.has('limitations_json');
  const additions = [
    ['search_mode', "TEXT NOT NULL DEFAULT 'local'"],
    ['web_search_status', "TEXT NOT NULL DEFAULT 'not_requested'"],
    ['result_quality', "TEXT NOT NULL DEFAULT 'pending' CHECK (result_quality IN ('pending', 'sufficient', 'limited', 'insufficient'))"],
    ['limitations_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['failed_stage', "TEXT NOT NULL DEFAULT ''"],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['cancel_requested', 'INTEGER NOT NULL DEFAULT 0'],
    ['session_id', "TEXT NOT NULL DEFAULT ''"],
    ['parent_task_id', "TEXT NOT NULL DEFAULT ''"],
    ['turn_index', 'INTEGER NOT NULL DEFAULT 1'],
    ['continuation_context_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['knowledge_base_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['artifacts_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['started_at', 'INTEGER'],
    ['finished_at', 'INTEGER']
  ];

  // IMMEDIATE 提前取得写锁，避免两个启动进程同时判断缺列后重复迁移。
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE research_tasks ADD COLUMN ${name} ${definition}`);
      }
    }

    // 历史 completed 任务从未经过 Phase A 质量评估，不能因新增列默认值而显示为
    // “待评估”或“证据充分”。只在首次加列时标记为受限，并明确保留未知原因。
    if (addsResultQuality) {
      db.exec(`
        UPDATE research_tasks
        SET result_quality = 'limited'
        WHERE status = 'completed'
      `);
    }
    if (addsLimitations) {
      db.exec(`
        UPDATE research_tasks
        SET limitations_json = '[{"code":"legacy_quality_unknown","message":"该历史任务未经过当前相关性与证据覆盖评估。"}]'
        WHERE status = 'completed'
      `);
    }

    db.exec(`
      UPDATE research_tasks
      SET search_mode = 'local'
      WHERE search_mode IS NULL OR search_mode NOT IN ('local', 'hybrid', 'web');

      UPDATE research_tasks
      SET web_search_status = CASE
        WHEN search_mode = 'local' THEN 'not_requested'
        ELSE 'pending'
      END
      WHERE web_search_status IS NULL
         OR web_search_status NOT IN ('not_requested', 'pending', 'available', 'unavailable', 'partial', 'error');

      UPDATE research_tasks
      SET result_quality = CASE WHEN status = 'completed' THEN 'limited' ELSE 'pending' END
      WHERE result_quality IS NULL
         OR result_quality NOT IN ('pending', 'sufficient', 'limited', 'insufficient');

      UPDATE research_tasks SET limitations_json = '[]'
      WHERE limitations_json IS NULL OR limitations_json = '';

      UPDATE research_tasks SET failed_stage = '' WHERE failed_stage IS NULL;
      UPDATE research_tasks SET attempt = 0 WHERE attempt IS NULL OR attempt < 0;
      UPDATE research_tasks SET cancel_requested = 0 WHERE cancel_requested IS NULL;
      UPDATE research_tasks SET session_id = id WHERE session_id IS NULL OR session_id = '';
      UPDATE research_tasks SET parent_task_id = '' WHERE parent_task_id IS NULL;
      UPDATE research_tasks SET turn_index = 1 WHERE turn_index IS NULL OR turn_index < 1;
      UPDATE research_tasks SET continuation_context_json = '{}'
      WHERE continuation_context_json IS NULL OR continuation_context_json = '';
      UPDATE research_tasks SET knowledge_base_ids_json = '[]' WHERE knowledge_base_ids_json IS NULL OR knowledge_base_ids_json = '';
      UPDATE research_tasks SET artifacts_json = '{}' WHERE artifacts_json IS NULL OR artifacts_json = '';

      CREATE INDEX IF NOT EXISTS idx_research_tasks_status_created
        ON research_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_research_tasks_updated
        ON research_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_tasks_session_turn
        ON research_tasks(session_id, turn_index, created_at);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertTransition(from, to) {
  // 同状态写入用于保存阶段进度，只有跨状态时才检查状态图。
  if (from === to) return;
  if (!STATUS_TRANSITIONS[from]?.has(to)) {
    throw createStoreError(
      'RESEARCH_INVALID_TRANSITION',
      `研究任务不能从 ${from} 转换为 ${to}`
    );
  }
}

/**
 * 接受 create({ question, ... })，并兼容早期 create(question, options) 调用形态。
 * 输出保证问题非空、检索模式合法、知识库范围去重限量。
 */
function normalizeCreateInput(input, options = {}) {
  const value = typeof input === 'object' && input !== null
    ? input
    : { ...options, question: input };
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question) {
    throw createStoreError('RESEARCH_QUESTION_REQUIRED', '研究问题不能为空', 400);
  }
  const searchMode = normalizeSearchMode(value.searchMode ?? value.requestedSearchMode);
  return {
    question: question.slice(0, 4000),
    searchMode,
    webSearchStatus: normalizeWebSearchStatus(value.webSearchStatus, searchMode),
    knowledgeBaseIds: normalizeKnowledgeBaseIds(value.knowledgeBaseIds),
    sessionId: boundedText(value.sessionId, 120),
    parentTaskId: boundedText(value.parentTaskId, 120),
    turnIndex: Math.max(1, Number(value.turnIndex) || 1),
    continuationContext: normalizeContinuationContext(value.continuationContext)
  };
}

/**
 * 打开研究数据库并返回同步任务 Store。WAL 允许页面轮询读取时 Worker 继续写入；
 * busy_timeout 则给短暂写锁竞争留出重试窗口。
 */
export function createResearchStore(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrateDatabase(db);

  const getStatement = db.prepare('SELECT * FROM research_tasks WHERE id = ?');
  const readTask = (id) => mapTask(getStatement.get(id));

  /** 新任务只进入 queued；真正进入 running 必须经过 claim。 */
  function create(input, options) {
    const normalized = normalizeCreateInput(input, options);
    const now = Date.now();
    const id = `research-${randomUUID()}`;
    const sessionId = normalized.sessionId || id;
    db.prepare(`
      INSERT INTO research_tasks (
        id, question, status, stage, progress, error, report, citations_json,
        search_mode, web_search_status, result_quality, limitations_json,
        failed_stage, attempt, cancel_requested,
        session_id, parent_task_id, turn_index, continuation_context_json,
        knowledge_base_ids_json, artifacts_json, created_at, updated_at,
        started_at, finished_at
      ) VALUES (?, ?, 'queued', 'planning', 0, '', '', '[]', ?, ?, 'pending', '[]', '', 0, 0, ?, ?, ?, ?, ?, '{}', ?, ?, NULL, NULL)
    `).run(
      id,
      normalized.question,
      normalized.searchMode,
      normalized.webSearchStatus,
      sessionId,
      normalized.parentTaskId,
      normalized.turnIndex,
      JSON.stringify(normalized.continuationContext || {}),
      JSON.stringify(normalized.knowledgeBaseIds),
      now,
      now
    );
    return readTask(id);
  }

  /** 分页读取历史任务；status 只有属于领域枚举时才参与筛选。 */
  function list(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    const offset = Math.max(0, Number(options.offset) || 0);
    if (RESEARCH_STATUSES.has(options.status)) {
      return db.prepare(`
        SELECT * FROM research_tasks
        WHERE status = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(options.status, limit, offset).map(mapTask);
    }
    return db.prepare(`
      SELECT * FROM research_tasks
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset).map(mapTask);
  }

  function listSession(id) {
    const task = readTask(id);
    if (!task) return null;
    const sessionId = task.sessionId || task.id;
    return db.prepare(`
      SELECT * FROM research_tasks
      WHERE session_id = ?
      ORDER BY turn_index ASC, created_at ASC
    `).all(sessionId).map(mapTask);
  }

  function buildContinuationContext(parent, root) {
    return normalizeContinuationContext({
      originQuestion: root.question,
      parent: {
        taskId: parent.id,
        question: parent.question,
        reportExcerpt: parent.report,
        resultQuality: parent.resultQuality,
        limitations: parent.limitations
      },
      citations: parent.citations.map((citation) => ({
        ...citation,
        originTaskId: parent.id
      }))
    });
  }

  /**
   * completed Run 不会被重新排队；追问始终创建同 Session 的新 Run，保留每轮的
   * 计划、证据和报告。一个 Session 同时只能运行一轮，避免两个后续结论争夺上下文。
   */
  function continueSession(id, input = {}) {
    const parent = readTask(id);
    if (!parent) return null;
    if (parent.status !== 'completed') {
      throw createStoreError('RESEARCH_FOLLOW_UP_REQUIRES_COMPLETED', '只能基于已完成的研究继续追问');
    }
    const runs = listSession(parent.id) || [];
    if (runs.some((task) => task.status === 'queued' || task.status === 'running')) {
      throw createStoreError('RESEARCH_SESSION_BUSY', '当前研究会话已有进行中的轮次，请等待其完成后再继续追问');
    }
    const root = runs.find((task) => !task.parentTaskId) || runs[0] || parent;
    const nextTurnIndex = Math.max(...runs.map((task) => task.turnIndex), 0) + 1;
    return create({
      question: input.question,
      searchMode: input.searchMode ?? parent.searchMode,
      knowledgeBaseIds: input.knowledgeBaseIds ?? parent.knowledgeBaseIds,
      sessionId: parent.sessionId,
      parentTaskId: parent.id,
      turnIndex: nextTurnIndex,
      continuationContext: buildContinuationContext(parent, root)
    });
  }

  /**
   * 所有常规更新最终都经过这里：先验证状态转换，再构造完整 next 快照并一次 UPDATE。
   * 未出现在 patch 中的 artifacts、引用和时间字段会保留，保证重试可从已完成阶段续跑。
   */
  function writeTask(id, old, patch) {
    const nextStatus = patch.status ?? old.status;
    assertTransition(old.status, nextStatus);

    const nextSearchMode = patch.searchMode === undefined
      ? old.searchMode
      : normalizeSearchMode(patch.searchMode);
    const next = {
      ...old,
      ...patch,
      status: nextStatus,
      stage: RESEARCH_STAGES.has(patch.stage) ? patch.stage : old.stage,
      progress: Math.max(0, Math.min(100, Number(patch.progress ?? old.progress) || 0)),
      error: typeof patch.error === 'string' ? patch.error : old.error,
      report: typeof patch.report === 'string' ? patch.report : old.report,
      citations: patch.citations === undefined ? old.citations : normalizeCitations(patch.citations),
      searchMode: nextSearchMode,
      webSearchStatus: patch.webSearchStatus === undefined
        ? old.webSearchStatus
        : normalizeWebSearchStatus(patch.webSearchStatus, nextSearchMode),
      resultQuality: patch.resultQuality === undefined
        ? old.resultQuality
        : normalizeResultQuality(patch.resultQuality),
      limitations: patch.limitations === undefined
        ? old.limitations
        : normalizeLimitations(patch.limitations),
      failedStage: patch.failedStage === undefined
        ? old.failedStage
        : (RESEARCH_STAGES.has(patch.failedStage) ? patch.failedStage : ''),
      attempt: Math.max(0, Number(patch.attempt ?? old.attempt) || 0),
      cancelRequested: patch.cancelRequested === undefined
        ? old.cancelRequested
        : Boolean(patch.cancelRequested),
      knowledgeBaseIds: patch.knowledgeBaseIds === undefined
        ? old.knowledgeBaseIds
        : normalizeKnowledgeBaseIds(patch.knowledgeBaseIds),
      artifacts: patch.artifacts === undefined
        ? old.artifacts
        : normalizeArtifacts(patch.artifacts),
      startedAt: patch.startedAt === undefined ? old.startedAt : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? old.finishedAt : patch.finishedAt,
      updatedAt: Date.now()
    };

    db.prepare(`
      UPDATE research_tasks SET
        status = ?, stage = ?, progress = ?, error = ?, report = ?,
        citations_json = ?, search_mode = ?, web_search_status = ?,
        result_quality = ?, limitations_json = ?, failed_stage = ?,
        attempt = ?, cancel_requested = ?,
        knowledge_base_ids_json = ?, artifacts_json = ?, updated_at = ?,
        started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      next.status,
      next.stage,
      next.progress,
      next.error,
      next.report,
      JSON.stringify(next.citations),
      next.searchMode,
      next.webSearchStatus,
      next.resultQuality,
      JSON.stringify(next.limitations),
      next.failedStage,
      next.attempt,
      next.cancelRequested ? 1 : 0,
      JSON.stringify(next.knowledgeBaseIds),
      JSON.stringify(next.artifacts),
      next.updatedAt,
      next.startedAt,
      next.finishedAt,
      id
    );
    return readTask(id);
  }

  function update(id, patch = {}) {
    const old = readTask(id);
    if (!old) return null;

    const nextStatus = patch.status ?? old.status;
    // queued 是一次新执行尝试的入口：清掉上次终态错误与取消标志，但保留阶段产物。
    // 对 completed/running 等非法来源仍交给 assertTransition 拒绝。
    if (nextStatus === 'queued' && old.status !== 'queued') {
      if (old.status !== 'failed' && old.status !== 'cancelled') {
        assertTransition(old.status, nextStatus);
      }
      return writeTask(id, old, {
        ...patch,
        status: 'queued',
        cancelRequested: false,
        error: patch.error ?? '',
        failedStage: patch.failedStage ?? '',
        finishedAt: null
      });
    }
    return writeTask(id, old, patch);
  }

  /**
   * 原子领取 queued 任务的执行权。先读用于快速判断，真正的互斥由带 WHERE 条件的
   * UPDATE 保证：多个 Worker 同时 claim 时只有一个 changes=1。attempt 每次领取加一，
   * startedAt 保留首次开始时间，finishedAt 为本次执行重新清空。
   */
  function claim(id) {
    const old = readTask(id);
    if (!old || old.status !== 'queued' || old.cancelRequested) return null;
    const now = Date.now();
    const result = db.prepare(`
      UPDATE research_tasks
      SET status = 'running', attempt = attempt + 1, error = '',
          failed_stage = '', cancel_requested = 0, updated_at = ?,
          started_at = COALESCE(started_at, ?), finished_at = NULL
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0
    `).run(now, now, id);
    return result.changes ? readTask(id) : null;
  }

  /** 仅运行中的、且未请求取消的任务可以写阶段快照，防止迟到结果覆盖终态。 */
  function updateRunning(id, patch = {}) {
    const old = readTask(id);
    if (!old || old.status !== 'running' || old.cancelRequested) return null;
    return writeTask(id, old, { ...patch, status: 'running' });
  }

  /** 完成操作固定 stage/progress 和完成时间，不接受从 queued 直接跳到 completed。 */
  function complete(id, patch = {}) {
    const old = readTask(id);
    if (!old || old.status !== 'running' || old.cancelRequested) return null;
    return writeTask(id, old, {
      ...patch,
      status: 'completed',
      stage: 'completed',
      progress: 100,
      error: '',
      failedStage: '',
      finishedAt: Date.now()
    });
  }

  /** 失败时同时保存 failedStage，页面才能指出具体失败步骤并从该阶段重试。 */
  function fail(id, details = {}) {
    const old = readTask(id);
    if (!old || old.status !== 'running' || old.cancelRequested) return null;
    const failedStage = RESEARCH_STAGES.has(details.failedStage)
      ? details.failedStage
      : old.stage;
    return writeTask(id, old, {
      ...details,
      status: 'failed',
      stage: failedStage,
      failedStage,
      error: String(details.error || '研究任务失败'),
      finishedAt: Date.now()
    });
  }

  /**
   * 持久化取消意图并立即把任务置为 cancelled。Store 本身不能中断正在等待的网络 I/O；
   * Worker 随后会 abort 对应 controller，而写入守卫可阻止迟到结果覆盖 cancelled。
   */
  function cancel(id) {
    const old = readTask(id);
    if (!old) return null;
    if (old.status === 'cancelled') return old;
    if (old.status !== 'queued' && old.status !== 'running') {
      throw createStoreError(
        'RESEARCH_INVALID_TRANSITION',
        `只有排队中或运行中的研究任务可以取消`
      );
    }
    return writeTask(id, old, {
      status: 'cancelled',
      cancelRequested: true,
      finishedAt: Date.now()
    });
  }

  /**
   * failed/cancelled 才可重试。重试保留 artifacts、stage 和原始范围，清理错误与
   * cancelRequested 后回到 queued，由 Worker 重新 claim。
   */
  function retry(id) {
    const old = readTask(id);
    if (!old) return null;
    if (old.status !== 'failed' && old.status !== 'cancelled') {
      throw createStoreError(
        'RESEARCH_INVALID_TRANSITION',
        '只有失败或已取消的研究任务可以重试'
      );
    }
    return writeTask(id, old, {
      status: 'queued',
      error: '',
      failedStage: '',
      resultQuality: 'pending',
      limitations: [],
      cancelRequested: false,
      finishedAt: null
    });
  }

  // FIFO 恢复：按创建时间返回全部 queued 任务，避免重启后只恢复最近一页。
  function listResumable() {
    return db.prepare(`
      SELECT * FROM research_tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
    `).all().map(mapTask);
  }

  /**
   * 进程启动恢复。数据库里的 running 属于已经消失的旧进程：若此前已持久化取消请求，
   * 收敛为 cancelled；否则回到 queued。stage/artifacts 原样保留，因此重新 claim 后会
   * 重做尚未确认完成的当前阶段，而不必从 planning 全部开始。
   */
  function resume() {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE research_tasks
        SET status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'queued' END,
            error = CASE WHEN cancel_requested = 1 THEN error ELSE '' END,
            finished_at = CASE WHEN cancel_requested = 1 THEN ? ELSE NULL END,
            updated_at = ?
        WHERE status = 'running'
      `).run(now, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return listResumable();
  }

  // —— Phase 1 Harness shadow（Spec research-harness §8/§9，二次修正强化）——
  // 契约检查、RunBudget 计数与错误分类只写入独立 side table，绝不回写任务状态机：
  // shadow 结果丢失或缺失都不影响 completed/failed 语义。
  //
  // 写入守卫（Codex 二次评审）：所有 snapshot 写入必须携带并校验当前 Run 的
  // attempt 与允许状态，拒绝旧 attempt 的迟到写入；写入与 research_tasks.updatedAt
  // 的原子推进在同一个事务内完成，保证前端轮询按 updatedAt 仲裁时能看到一致快照。
  // 允许的终态写入分类：
  // - contract：仅 completed（最终 verdict 在对应 attempt 完成后写入）；
  // - budget：running（增量）/ completed / failed（终态快照）；cancelled 拒绝；
  // - error：仅 failed；
  // - evidence ledger / artifacts / diffs：running（extracting 阶段写入）与
  //   completed（重评覆盖）；shadow 持久化故障只输出结构化日志（worker.shadowWarn）。

  function withRunSnapshotWrite(runId, attempt, allowedStatuses, write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT attempt, status, updated_at FROM research_tasks WHERE id = ?').get(runId);
      if (!row || Number(row.attempt) !== Number(attempt) || !allowedStatuses.includes(row.status)) {
        db.exec('ROLLBACK');
        return false;
      }
      // 严格单调：即使同一毫秒内连续写入，也保证至少比上一值大 1（前端按 updatedAt
      // 仲裁，重复值会让新快照被误判为旧）。
      const now = Math.max(Date.now(), Number(row.updated_at) + 1);
      write(now);
      const bumped = db.prepare(
        'UPDATE research_tasks SET updated_at = ? WHERE id = ? AND attempt = ?'
      ).run(now, runId, Number(attempt));
      if (!bumped.changes) {
        db.exec('ROLLBACK');
        return false;
      }
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已回滚 */ }
      throw error;
    }
  }

  function recordContractChecks(runId, verdict, { attempt } = {}) {
    if (!verdict || !Array.isArray(verdict.checks)) return false;
    return withRunSnapshotWrite(runId, attempt, ['completed'], (now) => {
      // 单事务整体替换：先清空该 run 的旧 checks 再写入新 verdict，
      // 避免新旧 verdict 混合（重试/重评后旧检查项残留）。
      db.prepare('DELETE FROM research_contract_checks WHERE run_id = ?').run(runId);
      const insert = db.prepare(`
        INSERT INTO research_contract_checks (
          run_id, check_id, kind, required, passed, threshold, verifier, verifier_version,
          observed_json, artifact_refs_json, explanation, not_evaluable_cause, mode,
          next_action, next_action_reason, verdict_passed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of verdict.checks) {
        insert.run(
          runId,
          String(item.id || ''),
          String(item.kind || ''),
          item.required === true ? 1 : 0,
          item.passed === true ? 1 : item.passed === false ? 0 : null,
          Number.isFinite(Number(item.threshold)) ? Number(item.threshold) : null,
          String(item.verifier || 'completion-policy'),
          Number(item.verifierVersion || 2),
          JSON.stringify(item.observed || {}),
          JSON.stringify(Array.isArray(item.artifactRefs) ? item.artifactRefs : []),
          String(item.explanation || ''),
          item.notEvaluableCause || null,
          String(verdict.mode || 'shadow'),
          String(verdict.nextAction || 'complete'),
          String(verdict.nextActionReason || ''),
          verdict.passed === true ? 1 : verdict.passed === false ? 0 : null,
          now
        );
      }
    });
  }

  function getContractChecks(runId) {
    const rows = db.prepare(
      'SELECT * FROM research_contract_checks WHERE run_id = ? ORDER BY check_id'
    ).all(runId);
    if (!rows.length) return null;
    const head = rows[0];
    const checks = rows.map((row) => ({      id: row.check_id,
      kind: row.kind,
      required: row.required === 1,
      passed: row.passed === null ? null : row.passed === 1,
      threshold: row.threshold,
      verifier: row.verifier,
      verifierVersion: row.verifier_version,
      observed: parseJson(row.observed_json, {}),
      artifactRefs: parseJson(row.artifact_refs_json, []),
      explanation: row.explanation,
      notEvaluableCause: row.not_evaluable_cause || null
    }));
    return {
      mode: head.mode,
      passed: head.verdict_passed === null ? null : head.verdict_passed === 1,
      nextAction: head.next_action,
      nextActionReason: head.next_action_reason,
      checks,
      deliveryFailures: checks.filter((item) => item.required && item.passed === false).map((item) => item.id),
      qualityFailures: checks.filter((item) => !item.required && item.passed === false).map((item) => item.id),
      notEvaluableRequired: checks.filter((item) => item.required && item.passed === null).map((item) => item.id)
    };
  }

  function upsertRunBudget(runId, snapshot, { attempt } = {}) {
    const safe = snapshot || {};
    // web_search_calls 不在此覆盖：它是 Provider 调用边界的累计计数，
    // 只能通过 addRunBudgetWebSearchCalls 递增（重启/重试后保持累计）。
    return withRunSnapshotWrite(runId, attempt, ['running', 'completed', 'failed'], (now) => {
      db.prepare(`
        INSERT INTO research_run_budget (
          run_id, wall_time_ms, web_search_calls,
          targeted_replans_used, targeted_replans_limit,
          report_repairs_used, report_repairs_limit,
          adapter_retries_used, adapter_retries_limit,
          writer_input_tokens, writer_output_tokens, updated_at
        ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          wall_time_ms = excluded.wall_time_ms,
          targeted_replans_used = excluded.targeted_replans_used,
          targeted_replans_limit = excluded.targeted_replans_limit,
          report_repairs_used = excluded.report_repairs_used,
          report_repairs_limit = excluded.report_repairs_limit,
          adapter_retries_used = excluded.adapter_retries_used,
          adapter_retries_limit = excluded.adapter_retries_limit,
          writer_input_tokens = excluded.writer_input_tokens,
          writer_output_tokens = excluded.writer_output_tokens,
          updated_at = excluded.updated_at
      `).run(
        runId,
        Math.max(0, Math.round(Number(safe.wallTimeMs) || 0)),
        Math.max(0, Math.round(Number(safe.targetedReplansUsed) || 0)),
        Math.max(1, Math.round(Number(safe.targetedReplansLimit) || 1)),
        Math.max(0, Math.round(Number(safe.reportRepairsUsed) || 0)),
        Math.max(1, Math.round(Number(safe.reportRepairsLimit) || 1)),
        Math.max(0, Math.round(Number(safe.adapterRetriesUsed) || 0)),
        Math.max(1, Math.round(Number(safe.adapterRetriesLimit) || 3)),
        Math.max(0, Math.round(Number(safe.writerInputTokens) || 0)),
        Math.max(0, Math.round(Number(safe.writerOutputTokens) || 0)),
        now
      );
    });
  }

  function addRunBudgetWebSearchCalls(runId, delta, { attempt } = {}) {
    const increment = Math.max(0, Math.round(Number(delta) || 0));
    if (!increment) return true;
    return withRunSnapshotWrite(runId, attempt, ['running'], (now) => {
      db.prepare(`
        INSERT INTO research_run_budget (
          run_id, wall_time_ms, web_search_calls,
          targeted_replans_used, targeted_replans_limit,
          report_repairs_used, report_repairs_limit,
          adapter_retries_used, adapter_retries_limit,
          writer_input_tokens, writer_output_tokens, updated_at
        ) VALUES (?, 0, ?, 0, 1, 0, 1, 0, 3, 0, 0, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          web_search_calls = web_search_calls + excluded.web_search_calls,
          updated_at = excluded.updated_at
      `).run(runId, increment, now);
    });
  }

  function getRunBudget(runId) {
    const row = db.prepare('SELECT * FROM research_run_budget WHERE run_id = ?').get(runId);
    if (!row) return null;
    return {
      wallTimeMs: row.wall_time_ms,
      webSearchCalls: row.web_search_calls,
      targetedReplans: { used: row.targeted_replans_used, limit: row.targeted_replans_limit },
      reportRepairs: { used: row.report_repairs_used, limit: row.report_repairs_limit },
      adapterRetries: { used: row.adapter_retries_used, limit: row.adapter_retries_limit },
      writerTokens: { input: row.writer_input_tokens, output: row.writer_output_tokens },
      updatedAt: row.updated_at
    };
  }

  function recordRunError(runId, { stage = '', category = 'internal', code = '', message = '', retryable = false } = {}, { attempt } = {}) {
    return withRunSnapshotWrite(runId, attempt, ['failed'], (now) => {
      db.prepare(`
        INSERT INTO research_run_errors (run_id, stage, category, code, message, retryable, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(runId, String(stage || ''), String(category || 'internal'), String(code || ''),
        String(message || '').slice(0, 2000), retryable === true ? 1 : 0, now);
    });
  }

  // shadow 自身的持久化故障只输出结构化日志（worker.shadowWarn），不写库——
  // 这是 Codex 终审第 4 点的二选一决定：不为"没能写库"再引入第二层兜底写。

  function listRunErrors(runId) {
    return db.prepare(
      'SELECT stage, category, code, message, retryable, created_at FROM research_run_errors WHERE run_id = ? ORDER BY created_at'
    ).all(runId).map((row) => ({
      stage: row.stage,
      category: row.category,
      code: row.code,
      message: row.message,
      retryable: row.retryable === 1,
      createdAt: row.created_at
    }));
  }

  // —— Phase 2A Evidence Ledger（Spec research-harness §7）——
  // 台账/原文 artifact/差异报告均为独立 side table；shadow 模式下旧证据路径继续
  // 供 Writer 使用，台账只记录 would-be 输入与差异。写入走 attempt 守卫事务并
  // 原子推进 updatedAt（与其他 snapshot 一致）。

  function recordEvidenceLedger(runId, { entries = [], artifacts = [], diff = null, ledgerVersion = 1 } = {}, { attempt } = {}) {
    if (!Array.isArray(entries)) return false;
    return withRunSnapshotWrite(runId, attempt, ['running', 'completed'], (now) => {
      // 台账按 Run 整体重建：同一 attempt 内重复写入（如重评）以最新快照为准。
      // diff 必须先删后写：新快照无 diff 时不得残留旧值。
      db.prepare('DELETE FROM research_evidence_ledger WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM research_evidence_artifacts WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM research_evidence_ledger_diffs WHERE run_id = ?').run(runId);
      const insertEntry = db.prepare(`
        INSERT INTO research_evidence_ledger (
          run_id, evidence_id, source_channel, canonical_source_id, canonical_url,
          title, domain, published_at, source_type,
          provenance_before, provenance_after, provenance_transition_json,
          subquestion_id, query, provider, reader_kind, content_hash, truncated,
          artifact_id, screening_status, screening_reason, reading_status,
          reading_reason, extraction_status, extraction_reason,
          reader_attestation, reader_attestation_reason,
          citation_status, citation_id,
          ledger_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of entries) {
        insertEntry.run(
          runId,
          String(item.evidenceId || ''),
          String(item.sourceChannel || ''),
          String(item.canonicalSourceId || ''),
          String(item.canonicalUrl || ''),
          String(item.title || ''),
          String(item.domain || ''),
          String(item.publishedAt || ''),
          String(item.sourceType || ''),
          String(item.provenanceBefore || 'unknown'),
          String(item.provenanceAfter || 'unknown'),
          JSON.stringify(item.provenanceTransition || null),
          String(item.subquestionId || ''),
          String(item.query || ''),
          String(item.provider || ''),
          String(item.readerKind || ''),
          String(item.contentHash || ''),
          item.truncated === true ? 1 : 0,
          String(item.artifactId || ''),
          String(item.screeningStatus || 'pending'),
          String(item.screeningReason || ''),
          String(item.readingStatus || 'pending'),
          String(item.readingReason || ''),
          String(item.extractionStatus || 'not_selected'),
          String(item.extractionReason || ''),
          String(item.readerAttestation || ''),
          String(item.readerAttestationReason || ''),
          String(item.citationStatus || 'pending'),
          String(item.citationId || ''),
          Number(item.ledgerVersion || ledgerVersion),
          now,
          now
        );
      }
      const insertArtifact = db.prepare(`
        INSERT INTO research_evidence_artifacts (
          artifact_id, run_id, kind, content_hash, byte_size, truncated, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifacts) {
        insertArtifact.run(
          String(artifact.artifactId || ''),
          runId,
          String(artifact.kind || 'source_content'),
          String(artifact.contentHash || ''),
          Math.max(0, Math.round(Number(artifact.byteSize) || 0)),
          artifact.truncated === true ? 1 : 0,
          String(artifact.content || ''),
          now
        );
      }
      if (diff) {
        db.prepare(`
          INSERT INTO research_evidence_ledger_diffs (run_id, mode, ledger_version, diff_json, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            mode = excluded.mode,
            ledger_version = excluded.ledger_version,
            diff_json = excluded.diff_json,
            created_at = excluded.created_at
        `).run(runId, String(diff.mode || 'shadow'), Number(ledgerVersion), JSON.stringify(diff), now);
      }
    });
  }

  function getEvidenceLedger(runId) {
    const rows = db.prepare(
      'SELECT * FROM research_evidence_ledger WHERE run_id = ? ORDER BY evidence_id'
    ).all(runId);
    if (!rows.length) return null;
    const diffRow = db.prepare(
      'SELECT mode, ledger_version, diff_json, created_at FROM research_evidence_ledger_diffs WHERE run_id = ?'
    ).get(runId);
    return {
      ledgerVersion: rows[0].ledger_version,
      entries: rows.map((row) => ({
        evidenceId: row.evidence_id,
        sourceChannel: row.source_channel,
        canonicalSourceId: row.canonical_source_id,
        canonicalUrl: row.canonical_url,
        title: row.title,
        domain: row.domain,
        publishedAt: row.published_at,
        sourceType: row.source_type,
        provenanceBefore: row.provenance_before,
        provenanceAfter: row.provenance_after,
        provenanceTransition: parseJson(row.provenance_transition_json, null),
        subquestionId: row.subquestion_id,
        query: row.query,
        provider: row.provider,
        readerKind: row.reader_kind,
        contentHash: row.content_hash,
        truncated: row.truncated === 1,
        artifactId: row.artifact_id,
        screening: { status: row.screening_status, reason: row.screening_reason },
        reading: { status: row.reading_status, reason: row.reading_reason },
        extraction: { status: row.extraction_status, reason: row.extraction_reason },
        readerAttestation: {
          level: row.reader_attestation,
          reason: row.reader_attestation_reason
        },
        citation: { status: row.citation_status, citationId: row.citation_id }
      })),
      artifacts: db.prepare(
        'SELECT artifact_id, run_id, kind, content_hash, byte_size, truncated, created_at FROM research_evidence_artifacts WHERE run_id = ? ORDER BY artifact_id'
      ).all(runId).map((row) => ({
        artifactId: row.artifact_id,
        runId: row.run_id,
        kind: row.kind,
        contentHash: row.content_hash,
        byteSize: row.byte_size,
        truncated: row.truncated === 1,
        createdAt: row.created_at
      })),
      diff: diffRow
        ? { mode: diffRow.mode, ledgerVersion: diffRow.ledger_version, ...parseJson(diffRow.diff_json, {}) }
        : null
    };
  }

  /**
   * 深组合提交（Codex Phase 2A 评审第 3 点）：主任务快照（updateRunning 语义）与
   * Evidence Ledger 侧写（整体替换或 citation 终态）在同一个事务内提交，消除
   * "任务已进入下一阶段、Ledger 尚未写入"的崩溃窗口。ledger 为 null 时退化为
   * 普通 updateRunning。不把 documents 塞进 task artifacts，不引入事件总线。
   *
   * ledger.type = 'replace'：extracting 阶段整体替换 { entries, artifacts, diff }。
   * ledger.type = 'citations'：verifying 阶段按 verification.referencedCitationIds
   *   将 citation_status 从 writer_selected/pending 收敛为 cited/not_cited。
   */
  function commitRunningStageWithLedger(runId, patch, { attempt } = {}, ledger = null) {
    return withRunSnapshotWrite(runId, attempt, ['running'], () => {
      const updated = updateRunning(runId, patch);
      if (!updated) {
        throw new Error('组合提交失败：主快照写入时任务已不在运行');
      }
      if (ledger?.type === 'replace') {
        writeLedgerReplace(runId, ledger, Date.now());
      }
      if (ledger?.type === 'citations') {
        finalizeLedgerCitations(runId, ledger.referencedCitationIds || [], Date.now());
      }
    });
  }

  function writeLedgerReplace(runId, { entries = [], artifacts = [], diff = null, ledgerVersion = 1 }, now) {
    // diff 先删后写：新快照无 diff 时不得残留旧值。
    db.prepare('DELETE FROM research_evidence_ledger WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM research_evidence_artifacts WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM research_evidence_ledger_diffs WHERE run_id = ?').run(runId);
    const insertEntry = db.prepare(`
      INSERT INTO research_evidence_ledger (
        run_id, evidence_id, source_channel, canonical_source_id, canonical_url,
        title, domain, published_at, source_type,
        provenance_before, provenance_after, provenance_transition_json,
        subquestion_id, query, provider, reader_kind, content_hash, truncated,
        artifact_id, screening_status, screening_reason, reading_status,
        reading_reason, extraction_status, extraction_reason,
        reader_attestation, reader_attestation_reason,
        citation_status, citation_id,
        ledger_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of entries) {
      insertEntry.run(
        runId,
        String(item.evidenceId || ''),
        String(item.sourceChannel || ''),
        String(item.canonicalSourceId || ''),
        String(item.canonicalUrl || ''),
        String(item.title || ''),
        String(item.domain || ''),
        String(item.publishedAt || ''),
        String(item.sourceType || ''),
        String(item.provenanceBefore || 'unknown'),
        String(item.provenanceAfter || 'unknown'),
        JSON.stringify(item.provenanceTransition || null),
        String(item.subquestionId || ''),
        String(item.query || ''),
        String(item.provider || ''),
        String(item.readerKind || ''),
        String(item.contentHash || ''),
        item.truncated === true ? 1 : 0,
        String(item.artifactId || ''),
        String(item.screeningStatus || 'pending'),
        String(item.screeningReason || ''),
        String(item.readingStatus || 'pending'),
        String(item.readingReason || ''),
        String(item.extractionStatus || 'not_selected'),
        String(item.extractionReason || ''),
        String(item.readerAttestation || ''),
        String(item.readerAttestationReason || ''),
        String(item.citationStatus || 'pending'),
        String(item.citationId || ''),
        Number(item.ledgerVersion || ledgerVersion),
        now,
        now
      );
    }
    const insertArtifact = db.prepare(`
      INSERT INTO research_evidence_artifacts (
        artifact_id, run_id, kind, content_hash, byte_size, truncated, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const artifact of artifacts) {
      insertArtifact.run(
        String(artifact.artifactId || ''),
        runId,
        String(artifact.kind || 'source_content'),
        String(artifact.contentHash || ''),
        Math.max(0, Math.round(Number(artifact.byteSize) || 0)),
        artifact.truncated === true ? 1 : 0,
        String(artifact.content || ''),
        now
      );
    }
    if (diff) {
      db.prepare(`
        INSERT INTO research_evidence_ledger_diffs (run_id, mode, ledger_version, diff_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, String(diff.mode || 'shadow'), Number(ledgerVersion), JSON.stringify(diff), now);
    }
  }

  function finalizeLedgerCitations(runId, referencedCitationIds, now) {
    // citation 终态只依据 verifying 阶段的 verification.referencedCitationIds：
    // 进入 Writer 输入（writer_selected）不等于最终被报告引用。
    const referenced = new Set(Array.isArray(referencedCitationIds) ? referencedCitationIds : []);
    const rows = db.prepare(
      'SELECT evidence_id, citation_id FROM research_evidence_ledger WHERE run_id = ?'
    ).all(runId);
    const update = db.prepare(
      'UPDATE research_evidence_ledger SET citation_status = ?, updated_at = ? WHERE run_id = ? AND evidence_id = ?'
    );
    for (const row of rows) {
      const status = row.citation_id && referenced.has(row.citation_id) ? 'cited' : 'not_cited';
      update.run(status, now, runId, row.evidence_id);
    }
  }

  return {
    create,
    get: readTask,
    recordContractChecks,
    getContractChecks,
    upsertRunBudget,
    addRunBudgetWebSearchCalls,
    getRunBudget,
    recordRunError,
    listRunErrors,
    recordEvidenceLedger,
    getEvidenceLedger,
    commitRunningStageWithLedger,
    list,
    listSession,
    continueSession,
    update,
    claim,
    updateRunning,
    complete,
    fail,
    cancel,
    retry,
    listResumable,
    resume,
    close() {
      db.close();
    }
  };
}

// 对旧导入路径保留别名；实际顺序由 research-domain.js 单点维护。
export const RESEARCH_STAGE_ORDER = RESEARCH_STAGE_VALUES;
