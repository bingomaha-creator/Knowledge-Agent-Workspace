/**
 * Agent 运行追踪的 SQLite 持久化层。
 *
 * 职责：保存一次对话 run 及其细粒度 span，维护开始/结束时间，并在 run
 * 收尾时汇总 token 与估算成本。它只负责“如实落库”，不决定业务步骤如何拆成
 * span，也不负责把事件推送到前端；这些编排工作由上层 tracer 完成。
 *
 * 核心不变量：新建记录先处于 running；正常路径必须显式 finish；进程重启时，
 * 上一次遗留的 running 记录会被收敛为 interrupted，避免时间线永久显示执行中。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/runs.sqlite');

// 数据库中的 JSON 是可恢复的附属信息。旧数据或损坏数据不应让整条时间线不可读。
function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    model: row.model,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    estimatedCost: Number(row.estimated_cost) || 0,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null
  };
}

function mapSpan(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id || null,
    name: row.name,
    kind: row.kind,
    status: row.status,
    model: row.model || '',
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    estimatedCost: Number(row.estimated_cost) || 0,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    metadata: parseJson(row.metadata_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    durationMs: row.duration_ms ?? null
  };
}

/**
 * 打开（必要时创建）运行追踪数据库，并返回同步 store API。
 * 输入是可选数据库路径；输出方法均返回前端友好的 camelCase 快照。
 * DatabaseSync 让单次状态转换在当前进程内有明确顺序，WAL 则改善读写并发。
 */
export function createRunStore(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_spans (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      parent_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_spans_run ON agent_spans(run_id, started_at);
  `);

  const selectRun = db.prepare('SELECT * FROM agent_runs WHERE id = ?');
  const selectSpan = db.prepare('SELECT * FROM agent_spans WHERE id = ?');

  /**
   * 服务启动恢复：running 只代表“当前进程仍持有执行权”。进程一旦重启，旧执行
   * 已不可能继续，因此在同一事务中终结所有孤儿 span 与 run。这里不伪装成 failed，
   * 而使用 interrupted，便于 UI 和后续 OpenTelemetry 映射区分业务失败与进程中断。
   */
  function recoverInterrupted() {
    const now = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE agent_spans
        SET status = 'interrupted', error_code = 'PROCESS_RESTARTED',
            error_message = '服务进程重启，未正常结束该 span。',
            finished_at = ?, duration_ms = MAX(0, ? - started_at)
        WHERE status = 'running'
      `).run(now, now);
      db.prepare(`
        UPDATE agent_runs
        SET status = 'interrupted', error_code = 'PROCESS_RESTARTED',
            error_message = '服务进程重启，未正常结束该 run。',
            updated_at = ?, finished_at = ?
        WHERE status = 'running'
      `).run(now, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 创建一次顶层对话运行；conversationId 用来查询同一会话的历史时间线。 */
  function startRun(input = {}) {
    const now = Date.now();
    const id = input.id || `run-${randomUUID()}`;
    db.prepare(`
      INSERT INTO agent_runs (
        id, conversation_id, status, model, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 'running', ?, ?, ?, ?)
    `).run(id, input.conversationId || '', input.model || '', JSON.stringify(input.metadata || {}), now, now);
    return mapRun(selectRun.get(id));
  }

  /**
   * 在指定 run 下开始一个操作 span。run 必须先存在；parentId 仅保存层级关系，
   * 当前 store 不替调用者检查父 span，也不自动级联结束子 span。
   */
  function startSpan(runId, input = {}) {
    if (!selectRun.get(runId)) throw new Error(`Run not found: ${runId}`);
    const now = Date.now();
    const id = input.id || `span-${randomUUID()}`;
    db.prepare(`
      INSERT INTO agent_spans (
        id, run_id, parent_id, name, kind, status, model, metadata_json, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      id,
      runId,
      input.parentId || null,
      input.name || 'operation',
      input.kind || 'internal',
      input.model || '',
      JSON.stringify(input.metadata || {}),
      now
    );
    return mapSpan(selectSpan.get(id));
  }

  /**
   * 将 span 写成终态并计算耗时。token/成本统一钳制为非负数，使缺失或异常的
   * 上游 usage 安全降级为 0；重复 finish 会以本次 patch 更新终态，而不会新增记录。
   */
  function finishSpan(id, patch = {}) {
    const existing = mapSpan(selectSpan.get(id));
    if (!existing) return null;
    const now = Date.now();
    db.prepare(`
      UPDATE agent_spans SET
        status = ?, model = ?, input_tokens = ?, output_tokens = ?, estimated_cost = ?,
        error_code = ?, error_message = ?, metadata_json = ?, finished_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(
      patch.status || 'success',
      patch.model ?? existing.model,
      Math.max(0, Number(patch.inputTokens ?? existing.inputTokens) || 0),
      Math.max(0, Number(patch.outputTokens ?? existing.outputTokens) || 0),
      Math.max(0, Number(patch.estimatedCost ?? existing.estimatedCost) || 0),
      patch.errorCode ?? existing.errorCode,
      patch.errorMessage ?? existing.errorMessage,
      JSON.stringify(patch.metadata ?? existing.metadata),
      now,
      Math.max(0, now - existing.startedAt),
      id
    );
    return mapSpan(selectSpan.get(id));
  }

  function listSpans(runId) {
    // 时间相同的 span 再按 id 排序，保证刷新后时间线顺序稳定。
    return db.prepare('SELECT * FROM agent_spans WHERE run_id = ? ORDER BY started_at, id')
      .all(runId)
      .map(mapSpan);
  }

  /**
   * 结束顶层 run。调用者没有显式给汇总值时，从所有 span 求和；因此上层约定只有
   * 真正消耗模型配额的 span 写 token/成本，纯编排 span 保持 0，避免重复计费。
   * 金额保留八位小数，以兼顾低单价模型和稳定序列化。
   */
  function finishRun(id, patch = {}) {
    const existing = mapRun(selectRun.get(id));
    if (!existing) return null;
    const now = Date.now();
    const spans = listSpans(id);
    const inputTokens = patch.inputTokens ?? spans.reduce((sum, span) => sum + span.inputTokens, 0);
    const outputTokens = patch.outputTokens ?? spans.reduce((sum, span) => sum + span.outputTokens, 0);
    const estimatedCost = patch.estimatedCost ?? spans.reduce((sum, span) => sum + span.estimatedCost, 0);
    db.prepare(`
      UPDATE agent_runs SET
        status = ?, input_tokens = ?, output_tokens = ?, estimated_cost = ?,
        error_code = ?, error_message = ?, metadata_json = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      patch.status || 'success',
      inputTokens,
      outputTokens,
      Number(estimatedCost.toFixed(8)),
      patch.errorCode ?? existing.errorCode,
      patch.errorMessage ?? existing.errorMessage,
      JSON.stringify(patch.metadata ?? existing.metadata),
      now,
      now,
      id
    );
    return mapRun(selectRun.get(id));
  }

  // 必须在暴露 store 前恢复：任何 API 查询都不应先看到上个进程遗留的假 running。
  recoverInterrupted();

  return {
    startRun,
    startSpan,
    finishSpan,
    finishRun,
    recoverInterrupted,
    getRun(id) {
      return mapRun(selectRun.get(id));
    },
    listSpans,
    getRunWithSpans(id) {
      const run = mapRun(selectRun.get(id));
      return run ? { ...run, spans: listSpans(id) } : null;
    },
    listRuns({ conversationId, limit = 100 } = {}) {
      // 对外查询设置硬上限，避免一次请求装载无限 run 及其全部 spans。
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      const rows = conversationId
        ? db.prepare(`
            SELECT * FROM agent_runs
            WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
          `).all(conversationId, boundedLimit)
        : db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?')
            .all(boundedLimit);
      return rows.map((row) => ({ ...mapRun(row), spans: listSpans(row.id) }));
    },
    close() {
      db.close();
    }
  };
}
