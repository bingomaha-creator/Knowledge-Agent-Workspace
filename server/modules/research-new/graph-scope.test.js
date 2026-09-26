import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readGraphScope } from './graph-scope.js';

test('Graph scope rejects unrelated bases and changed or withdrawn documents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manifest.json');
  const doc = { id: 'doc-a', content: 'body', documentType: 'generic', status: 'ready', publicationStatus: 'published' };
  const manifest = { status: 'ready', knowledgeBaseId: 'a', documents: [{ documentId: 'doc-a',
    contentHash: createHash('sha256').update('body').digest('hex') }] };
  const store = { listDocuments: () => [doc] };
  assert.throws(() => readGraphScope(file, store, ['a']), { code: 'RESEARCH_GRAPH_UNAVAILABLE' });
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.deepEqual(readGraphScope(file, store, ['a']), manifest);
  for (const ids of [['b'], ['a', 'b'], []]) assert.throws(() => readGraphScope(file, store, ids), { code: 'RESEARCH_GRAPH_SCOPE_INVALID' });
  doc.content = 'changed';
  assert.throws(() => readGraphScope(file, store, ['a']), { code: 'RESEARCH_GRAPH_STALE' });
  doc.content = 'body'; doc.publicationStatus = 'draft';
  assert.throws(() => readGraphScope(file, store, ['a']), { code: 'RESEARCH_GRAPH_STALE' });
});
