import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBugInvestigationStore } from './bug-investigation-store.js';

test('SQLite investigation store persists independent draft snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-investigation-store-'));
  const dbPath = path.join(directory, 'investigations.sqlite');
  const first = createBugInvestigationStore(dbPath);
  const created = first.create({
    id: 'investigation-1',
    projectRef: 'project-1',
    title: 'SSE parser failure',
    evidence: [{ id: 'evidence-1', type: 'error', content: 'Unexpected end of JSON input' }],
    facts: { errorSignatures: ['unexpected end of json input'] },
    analysis: { status: 'idle' },
    runs: [],
    candidateReadiness: { ready: false, checks: [] },
    createdAt: 10,
    updatedAt: 10
  });
  assert.equal(created.status, 'draft');
  first.update(created.id, {
    analysis: { status: 'success', hypotheses: [{ title: 'partial chunk' }] }
  });
  first.close();

  const reopened = createBugInvestigationStore(dbPath);
  assert.equal(reopened.get(created.id).analysis.hypotheses[0].title, 'partial chunk');
  assert.equal(reopened.list({ projectRef: 'project-1' }).length, 1);
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
