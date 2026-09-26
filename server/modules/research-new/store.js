import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createResearchNewError,
  DEFAULT_RESEARCH_NEW_BUDGET,
  normalizeKnowledgeBaseIds,
  normalizeResearchNewMode,
  RESEARCH_NEW_STAGES,
  RESEARCH_NEW_STATUSES
} from './domain.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/research-new.sqlite');
const STATUSES = new Set(RESEARCH_NEW_STATUSES);
const STAGES = new Set(RESEARCH_NEW_STAGES);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    mode: normalizeResearchNewMode(row.mode),
    knowledgeBaseIds: normalizeKnowledgeBaseIds(parseJson(row.knowledge_base_ids_json, [])),
    status: STATUSES.has(row.status) ? row.status : 'failed',
    stage: STAGES.has(row.stage) ? row.stage : 'planning',
    progress: Number(row.progress) || 0,
    error: row.error || '',
    resultQuality: ['pending', 'sufficient', 'limited', 'insufficient'].includes(row.result_quality)
      ? row.result_quality
      : 'pending',
    report: row.report || '',
    brief: objectValue(parseJson(row.brief_json, {})),
    tracks: arrayValue(parseJson(row.tracks_json, [])),
    diagnostics: objectValue(parseJson(row.diagnostics_json, {})),
    budget: { ...DEFAULT_RESEARCH_NEW_BUDGET, ...objectValue(parseJson(row.budget_json, {})) },
    attempt: Math.max(0, Number(row.attempt) || 0),
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null
  };
}

function mapSource(row) {
  return {
    id: row.id,
    runId: row.run_id,
    trackId: row.track_id,
    origin: row.origin,
    title: row.title,
    url: row.url || undefined,
    snippet: row.snippet,
    query: row.query,
    sourceKind: row.source_kind,
    knowledgeBaseId: row.knowledge_base_id,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    content: row.content,
    contentHash: row.content_hash,
    readerKind: row.reader_kind,
    contentLevel: row.content_level,
    readFailure: parseJson(row.read_failure_json, null),
    fetchedAt: row.fetched_at
  };
}

function mapEvidence(row) {
  return {
    id: row.id,
    runId: row.run_id,
    trackId: row.track_id,
    sourceId: row.source_id,
    origin: row.origin,
    passage: row.passage,
    passageHash: row.passage_hash,
    supports: arrayValue(parseJson(row.supports_json, [])),
    contradicts: arrayValue(parseJson(row.contradicts_json, [])),
    relevance: Number(row.relevance) || 0,
    sourceRole: row.source_role,
    contentLevel: row.content_level
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_new_runs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('web', 'hybrid')),
      knowledge_base_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      stage TEXT NOT NULL CHECK (stage IN ('planning', 'researching', 'assessing', 'reporting', 'verifying', 'completed')),
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      result_quality TEXT NOT NULL DEFAULT 'pending',
      report TEXT NOT NULL DEFAULT '',
      brief_json TEXT NOT NULL DEFAULT '{}',
      tracks_json TEXT NOT NULL DEFAULT '[]',
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}',
      attempt INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_research_new_runs_updated
      ON research_new_runs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_new_runs_status
      ON research_new_runs(status, created_at);

    CREATE TABLE IF NOT EXISTS research_new_sources (
      run_id TEXT NOT NULL REFERENCES research_new_runs(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('workspace', 'web')),
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'unknown',
      knowledge_base_id TEXT NOT NULL DEFAULT '',
      document_id TEXT NOT NULL DEFAULT '',
      chunk_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      reader_kind TEXT NOT NULL DEFAULT '',
      content_level TEXT NOT NULL DEFAULT '',
      read_failure_json TEXT NOT NULL DEFAULT 'null',
      fetched_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_research_new_sources_track
      ON research_new_sources(run_id, track_id);

    CREATE TABLE IF NOT EXISTS research_new_evidence (
      run_id TEXT NOT NULL REFERENCES research_new_runs(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('workspace', 'web')),
      passage TEXT NOT NULL,
      passage_hash TEXT NOT NULL,
      supports_json TEXT NOT NULL DEFAULT '[]',
      contradicts_json TEXT NOT NULL DEFAULT '[]',
      relevance REAL NOT NULL DEFAULT 0,
      source_role TEXT NOT NULL DEFAULT 'unknown',
      content_level TEXT NOT NULL,
      PRIMARY KEY (run_id, id),
      FOREIGN KEY (run_id, source_id) REFERENCES research_new_sources(run_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_research_new_evidence_track
      ON research_new_evidence(run_id, track_id);
  `);
}

export function createResearchNewStore(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(db);

  const readRun = (id) => mapRun(db.prepare('SELECT * FROM research_new_runs WHERE id = ?').get(id));
  const readSources = (id) => db.prepare(`
    SELECT * FROM research_new_sources WHERE run_id = ? ORDER BY track_id, id
  `).all(id).map(mapSource);
  const readEvidence = (id) => db.prepare(`
    SELECT * FROM research_new_evidence WHERE run_id = ? ORDER BY id
  `).all(id).map(mapEvidence);

  function get(id) {
    const run = readRun(id);
    return run ? { ...run, sources: readSources(id), evidence: readEvidence(id) } : null;
  }

  function create(input = {}) {
    const question = typeof input.question === 'string' ? input.question.trim().slice(0, 4000) : '';
    if (!question) throw createResearchNewError('RESEARCH_NEW_QUESTION_REQUIRED', '研究问题不能为空', 400);
    const mode = normalizeResearchNewMode(input.mode);
    const knowledgeBaseIds = normalizeKnowledgeBaseIds(input.knowledgeBaseIds);
    if (mode === 'hybrid' && knowledgeBaseIds.length === 0) {
      throw createResearchNewError('RESEARCH_NEW_KNOWLEDGE_REQUIRED', 'Hybrid 模式至少选择一个知识库', 400);
    }
    const now = Date.now();
    const id = `research-new-${randomUUID()}`;
    db.prepare(`
      INSERT INTO research_new_runs (
        id, question, mode, knowledge_base_ids_json, status, stage, progress,
        diagnostics_json, budget_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 'planning', 0, ?, ?, ?, ?)
    `).run(
      id,
      question,
      mode,
      JSON.stringify(knowledgeBaseIds),
      JSON.stringify({ engine: input.engine === 'sidecar' ? 'sidecar' : 'node',
        retrievalBackend: input.retrievalBackend === 'graphrag' ? 'graphrag' : 'workspace' }),
      JSON.stringify(DEFAULT_RESEARCH_NEW_BUDGET),
      now,
      now
    );
    return get(id);
  }

  function list(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const offset = Math.max(0, Number(options.offset) || 0);
    const rows = STATUSES.has(options.status)
      ? db.prepare('SELECT * FROM research_new_runs WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .all(options.status, limit, offset)
      : db.prepare('SELECT * FROM research_new_runs ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset);
    return rows.map(mapRun);
  }

  function claim(id) {
    const current = readRun(id);
    if (!current || !['queued', 'running'].includes(current.status) || current.cancelRequested) return null;
    const now = Date.now();
    const result = db.prepare(`
      UPDATE research_new_runs
      SET status = 'running', attempt = attempt + 1, error = '', cancel_requested = 0,
          started_at = COALESCE(started_at, ?), finished_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running') AND cancel_requested = 0
    `).run(now, now, id);
    return result.changes ? get(id) : null;
  }

  function writeSources(runId, sources) {
    db.prepare('DELETE FROM research_new_sources WHERE run_id = ?').run(runId);
    const insert = db.prepare(`
      INSERT INTO research_new_sources (
        run_id, id, track_id, origin, title, url, snippet, query, source_kind,
        knowledge_base_id, document_id, chunk_id, content, content_hash, reader_kind,
        content_level, read_failure_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const source of arrayValue(sources)) {
      insert.run(
        runId, source.id, source.trackId, source.origin, source.title || '', source.url || '',
        source.snippet || '', source.query || '', source.sourceKind || 'unknown',
        source.knowledgeBaseId || '', source.documentId || '', source.chunkId || '', source.content || '',
        source.contentHash || '', source.readerKind || '', source.contentLevel || '',
        JSON.stringify(source.readFailure || null), Number(source.fetchedAt) || 0
      );
    }
  }

  function writeEvidence(runId, evidence) {
    db.prepare('DELETE FROM research_new_evidence WHERE run_id = ?').run(runId);
    const insert = db.prepare(`
      INSERT INTO research_new_evidence (
        run_id, id, track_id, source_id, origin, passage, passage_hash,
        supports_json, contradicts_json, relevance, source_role, content_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of arrayValue(evidence)) {
      insert.run(
        runId, item.id, item.trackId, item.sourceId, item.origin, item.passage,
        item.passageHash, JSON.stringify(arrayValue(item.supports)),
        JSON.stringify(arrayValue(item.contradicts)), Number(item.relevance) || 0,
        item.sourceRole || 'unknown', item.contentLevel
      );
    }
  }

  function checkpoint(id, attempt, patch = {}) {
    const current = readRun(id);
    if (!current || current.status !== 'running' || current.cancelRequested || current.attempt !== attempt) {
      return null;
    }
    const stage = STAGES.has(patch.stage) ? patch.stage : current.stage;
    const existingEvidence = patch.sources !== undefined && patch.evidence === undefined
      ? readEvidence(id)
      : null;
    const now = Math.max(Date.now(), current.updatedAt + 1);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (patch.sources !== undefined) {
        writeSources(id, patch.sources);
        // 替换来源会触发 FK cascade；调用方没有显式替换 Evidence 时必须恢复当前快照。
        writeEvidence(id, patch.evidence === undefined ? existingEvidence : patch.evidence);
      } else if (patch.evidence !== undefined) {
        writeEvidence(id, patch.evidence);
      }
      const result = db.prepare(`
        UPDATE research_new_runs SET
          stage = ?, progress = ?, brief_json = ?, tracks_json = ?, diagnostics_json = ?,
          budget_json = ?, report = ?, result_quality = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND attempt = ? AND cancel_requested = 0
      `).run(
        stage,
        Math.max(current.progress, Math.min(99, Number(patch.progress ?? current.progress) || 0)),
        JSON.stringify(patch.brief === undefined ? current.brief : objectValue(patch.brief)),
        JSON.stringify(patch.tracks === undefined ? current.tracks : arrayValue(patch.tracks)),
        JSON.stringify(patch.diagnostics === undefined ? current.diagnostics : objectValue(patch.diagnostics)),
        JSON.stringify(patch.budget === undefined ? current.budget : { ...current.budget, ...objectValue(patch.budget) }),
        typeof patch.report === 'string' ? patch.report : current.report,
        patch.resultQuality || current.resultQuality,
        now,
        id,
        attempt
      );
      if (!result.changes) throw createResearchNewError('RESEARCH_NEW_SNAPSHOT_REJECTED', '研究快照已过期', 409);
      db.exec('COMMIT');
      return get(id);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function complete(id, attempt, patch = {}) {
    const current = readRun(id);
    if (!current || current.status !== 'running' || current.attempt !== attempt || current.cancelRequested) return null;
    const now = Math.max(Date.now(), current.updatedAt + 1);
    const result = db.prepare(`
      UPDATE research_new_runs SET status = 'completed', stage = 'completed', progress = 100,
        report = ?, result_quality = ?, tracks_json = ?, diagnostics_json = ?, budget_json = ?,
        error = '', finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt = ? AND cancel_requested = 0
    `).run(
      String(patch.report || current.report),
      patch.resultQuality || current.resultQuality,
      JSON.stringify(patch.tracks || current.tracks),
      JSON.stringify(patch.diagnostics || current.diagnostics),
      JSON.stringify(patch.budget || current.budget),
      now, now, id, attempt
    );
    return result.changes ? get(id) : null;
  }

  function fail(id, attempt, error) {
    const current = readRun(id);
    if (!current || current.status !== 'running' || current.attempt !== attempt) return current ? get(id) : null;
    const now = Math.max(Date.now(), current.updatedAt + 1);
    db.prepare(`
      UPDATE research_new_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt = ?
    `).run(String(error?.message || error || '研究执行失败').slice(0, 1000), now, now, id, attempt);
    return get(id);
  }

  function requestCancel(id) {
    const current = readRun(id);
    if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) return current ? get(id) : null;
    const now = Math.max(Date.now(), current.updatedAt + 1);
    if (current.status === 'queued') {
      db.prepare(`
        UPDATE research_new_runs SET status = 'cancelled', cancel_requested = 1,
          error = '研究任务已取消', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
      `).run(now, now, id);
    } else {
      db.prepare(`
        UPDATE research_new_runs SET cancel_requested = 1, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, id);
    }
    return get(id);
  }

  function cancel(id, attempt) {
    const current = readRun(id);
    if (!current || current.status !== 'running' || current.attempt !== attempt) return current ? get(id) : null;
    const now = Math.max(Date.now(), current.updatedAt + 1);
    db.prepare(`
      UPDATE research_new_runs SET status = 'cancelled', cancel_requested = 1,
        error = '研究任务已取消', finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt = ?
    `).run(now, now, id, attempt);
    return get(id);
  }

  return {
    create,
    get,
    list,
    claim,
    checkpoint,
    complete,
    fail,
    requestCancel,
    cancel,
    listRecoverable: (engine) => db.prepare(`
      SELECT * FROM research_new_runs WHERE status IN ('queued', 'running') ORDER BY created_at
    `).all().map(mapRun).filter((run) => !engine || (run.diagnostics.engine || 'node') === engine),
    close: () => db.close()
  };
}
