import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createResearchNewError } from './domain.js';

export function readGraphScope(manifestPath, knowledgeStore, knowledgeBaseIds) {
  const reject = (code, message) => { throw createResearchNewError(code, message, 409); };
  if (!fs.existsSync(manifestPath)) reject('RESEARCH_GRAPH_UNAVAILABLE', '所选资料库尚未建图');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 'ready' || knowledgeBaseIds.length !== 1
      || knowledgeBaseIds[0] !== manifest.knowledgeBaseId) {
    reject('RESEARCH_GRAPH_SCOPE_INVALID', '图谱研究只支持选择已建图的单个资料库');
  }
  const documents = knowledgeStore.listDocuments(knowledgeBaseIds).filter((doc) =>
    doc.status === 'ready' && doc.publicationStatus === 'published' && doc.documentType === 'generic');
  if (documents.length !== manifest.documents.length || manifest.documents.some((snapshot) => {
    const current = documents.find((doc) => doc.id === snapshot.documentId);
    return !current || createHash('sha256').update(current.content).digest('hex') !== snapshot.contentHash;
  })) reject('RESEARCH_GRAPH_STALE', '资料库已发生变更，请手动重建图谱后再使用 GraphRAG');
  return manifest;
}
