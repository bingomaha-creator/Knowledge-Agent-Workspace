import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUG_INVESTIGATION_STATUSES } from './bug-investigation-domain.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'server/data/bug-investigations.sqlite');
const STATUS_SET = new Set(BUG_INVESTIGATION_STATUSES);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapInvestigation(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectRef: row.project_ref,
    title: row.title,
    status: STATUS_SET.has(row.status) ? row.status : 'draft',
    evidence: parseJson(row.evidence_json, []),
    facts: parseJson(row.facts_json, {}),
    analysis: parseJson(row.analysis_json, {}),
    runs: parseJson(row.runs_json, []),
    candidateReadiness: parseJson(row.candidate_readiness_json, { ready: false, checks: [] }),
    candidateBugCaseId: row.candidate_bug_case_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createBugInvestigationStore(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bug_investigations (
      id TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'converted', 'closed')),
      evidence_json TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      runs_json TEXT NOT NULL,
      candidate_readiness_json TEXT NOT NULL,
      candidate_bug_case_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bug_investigations_project_updated
      ON bug_investigations(project_ref, updated_at DESC);
  `);

  const read = db.prepare('SELECT * FROM bug_investigations WHERE id = ?');

  function get(id) {
    return mapInvestigation(read.get(id));
  }

  function list(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    if (options.projectRef && STATUS_SET.has(options.status)) {
      return db.prepare(`
        SELECT * FROM bug_investigations
        WHERE project_ref = ? AND status = ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(options.projectRef, options.status, limit).map(mapInvestigation);
    }
    if (options.projectRef) {
      return db.prepare(`
        SELECT * FROM bug_investigations
        WHERE project_ref = ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(options.projectRef, limit).map(mapInvestigation);
    }
    return db.prepare(`
      SELECT * FROM bug_investigations
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit).map(mapInvestigation);
  }

  function create(input) {
    const now = input.createdAt || Date.now();
    const id = input.id || `bug-investigation-${randomUUID()}`;
    db.prepare(`
      INSERT INTO bug_investigations (
        id, project_ref, title, status, evidence_json, facts_json,
        analysis_json, runs_json, candidate_readiness_json,
        candidate_bug_case_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectRef,
      input.title,
      input.status || 'draft',
      JSON.stringify(input.evidence || []),
      JSON.stringify(input.facts || {}),
      JSON.stringify(input.analysis || {}),
      JSON.stringify(input.runs || []),
      JSON.stringify(input.candidateReadiness || { ready: false, checks: [] }),
      input.candidateBugCaseId || null,
      now,
      input.updatedAt || now
    );
    return get(id);
  }

  function update(id, patch = {}) {
    const current = get(id);
    if (!current) return null;
    const nextStatus = patch.status ?? current.status;
    if (!STATUS_SET.has(nextStatus)) {
      const error = new Error(`不支持的调查状态：${nextStatus}`);
      error.code = 'BUG_INVESTIGATION_INVALID_STATUS';
      error.status = 422;
      throw error;
    }
    const next = { ...current, ...patch, status: nextStatus, updatedAt: Date.now() };
    db.prepare(`
      UPDATE bug_investigations SET
        title = ?, status = ?, evidence_json = ?, facts_json = ?,
        analysis_json = ?, runs_json = ?, candidate_readiness_json = ?,
        candidate_bug_case_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.status,
      JSON.stringify(next.evidence),
      JSON.stringify(next.facts),
      JSON.stringify(next.analysis),
      JSON.stringify(next.runs),
      JSON.stringify(next.candidateReadiness),
      next.candidateBugCaseId,
      next.updatedAt,
      id
    );
    return get(id);
  }

  return {
    get,
    list,
    create,
    update,
    close() {
      db.close();
    }
  };
}
