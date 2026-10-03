import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportKnowledge } from './export-knowledge.mjs';

test('export is scoped, published-only, traceable and never overwrites a corpus', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-graph-export-'));
  const dbPath = path.join(dir, 'knowledge.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE knowledge_bases (id TEXT, name TEXT);
    CREATE TABLE documents (id TEXT, name TEXT, content TEXT, updated_at INTEGER,
      knowledge_base_id TEXT, status TEXT, publication_status TEXT, document_type TEXT);
    INSERT INTO knowledge_bases VALUES ('a', 'A');
    INSERT INTO documents VALUES ('published', '../unsafe.md', 'published content', 1, 'a', 'ready', 'published', 'generic');
    INSERT INTO documents VALUES ('draft', 'draft.md', 'private draft', 1, 'a', 'ready', 'draft', 'generic');
    INSERT INTO documents VALUES ('other', 'other.md', 'other base', 1, 'b', 'ready', 'published', 'generic');`);
  db.close();
  try {
    const output = path.join(dir, 'snapshot');
    const manifest = exportKnowledge(dbPath, 'a', output);
    assert.equal(manifest.documents.length, 1);
    const doc = manifest.documents[0];
    assert.equal(doc.documentId, 'published');
    assert.match(doc.fileName, /^[a-f0-9]{64}\.md$/);
    assert.equal(readFileSync(path.join(output, 'files', doc.fileName), 'utf8'), 'published content');
    assert.throws(() => exportKnowledge(dbPath, 'a', output), { code: 'EEXIST' });
    assert.throws(() => exportKnowledge(dbPath, 'missing', path.join(dir, 'missing')), /KNOWLEDGE_BASE_NOT_FOUND/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
