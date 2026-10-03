import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Manual snapshot only: never modify Knowledge, or overwrite an existing corpus.
export function exportKnowledge(dbPath, knowledgeBaseId, outputDir) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const base = db.prepare('SELECT id, name FROM knowledge_bases WHERE id = ?').get(knowledgeBaseId);
    if (!base) throw new Error('KNOWLEDGE_BASE_NOT_FOUND');
    const documents = db.prepare(`SELECT id, name, content, updated_at FROM documents
      WHERE knowledge_base_id = ? AND status = 'ready' AND publication_status = 'published'
      AND document_type = 'generic' ORDER BY id`).all(knowledgeBaseId);
    if (!documents.length) throw new Error('KNOWLEDGE_BASE_EMPTY');
    mkdirSync(outputDir); // Existing directory is an error, not a silent rebuild.
    const filesDir = path.join(outputDir, 'files');
    mkdirSync(filesDir);
    const manifest = { version: 1, status: 'exported', knowledgeBaseId, name: base.name,
      exportedAt: new Date().toISOString(), documents: documents.map((doc) => {
        const fileName = `${createHash('sha256').update(doc.id).digest('hex')}.md`;
        writeFileSync(path.join(filesDir, fileName), doc.content, { flag: 'wx' });
        return { documentId: doc.id, name: doc.name, fileName, updatedAt: doc.updated_at,
          contentHash: createHash('sha256').update(doc.content).digest('hex') };
      }) };
    writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return manifest;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [knowledgeBaseId, outputDir] = process.argv.slice(2);
  if (!knowledgeBaseId || !outputDir) throw new Error('Usage: node export-knowledge.mjs <kbId> <new-output-dir>');
  const manifest = exportKnowledge(path.resolve('server/data/knowledge.sqlite'), knowledgeBaseId, path.resolve(outputDir));
  console.log(JSON.stringify({ knowledgeBaseId, documents: manifest.documents.length, outputDir }));
}
