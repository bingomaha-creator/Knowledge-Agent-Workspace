import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunStore } from './run-store.js';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-runs-')), 'runs.sqlite');
}

test('run store persists runs and spans with aggregate usage', () => {
  const store = createRunStore(tempDbPath());
  const run = store.startRun({ conversationId: 'c', model: 'm' });
  const span = store.startSpan(run.id, { name: 'generation', kind: 'model', model: 'm' });
  store.finishSpan(span.id, { inputTokens: 3, outputTokens: 4, estimatedCost: 0.01 });
  const finished = store.finishRun(run.id);
  assert.equal(finished.inputTokens, 3);
  assert.equal(finished.outputTokens, 4);
  assert.equal(store.getRunWithSpans(run.id).spans.length, 1);
  store.close();
});

test('opening the store marks abandoned runs and spans interrupted', () => {
  const dbPath = tempDbPath();
  const first = createRunStore(dbPath);
  const run = first.startRun({ conversationId: 'c', model: 'm' });
  first.startSpan(run.id, { name: 'planning', kind: 'model' });
  first.close();

  const reopened = createRunStore(dbPath);
  const recovered = reopened.getRunWithSpans(run.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.errorCode, 'PROCESS_RESTARTED');
  assert.equal(recovered.spans[0].status, 'interrupted');
  reopened.close();
});
