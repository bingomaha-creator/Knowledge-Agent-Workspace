import { chunkDocument } from '../markdown-chunker.js';
import { tokenize } from '../rag-utils.js';

function readableError(error) {
  return error?.details
    ? `${error.message}\n${error.details}`
    : error?.message || String(error || '文档处理失败');
}

export function createKnowledgeIndexLifecycle({
  store,
  embeddingClient,
  chunkDocumentImpl = chunkDocument,
  tokenizeImpl = tokenize,
  scheduleTask = (task) => setTimeout(task, 0),
  idFactory = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  logger = console
}) {
  const processingJobs = new Map();
  let started = false;
  let disposed = false;
  let unsubscribe = null;

  async function processLatestGeneration(documentId) {
    while (!disposed) {
      const document = store.claimDocumentForIndex(documentId);
      if (!document) return;
      try {
        const parts = chunkDocumentImpl({ name: document.name, content: document.content });
        if (!parts.length) {
          throw Object.assign(new Error('知识文件内容为空'), {
            details: '无法从文件中生成有效分块。'
          });
        }
        const chunks = [];
        for (const [chunkIndex, part] of parts.entries()) {
          const embedding = await embeddingClient.embed(part.text);
          chunks.push({
            id: idFactory('chunk'),
            documentId: document.id,
            knowledgeBaseId: document.knowledgeBaseId || 'kb-default',
            documentName: document.name,
            text: part.text,
            headingPath: part.headingPath || [],
            kind: part.kind || 'plain-text',
            chunkIndex,
            tokens: tokenizeImpl(part.text),
            embedding
          });
        }
        const completed = store.completeDocumentIndex(documentId, chunks);
        if (completed) return;
      } catch (error) {
        const failed = store.failDocumentIndex(documentId, readableError(error));
        logger.error?.(
          `[knowledge] failed to process ${document.name}: ${error?.message || error}`
        );
        if (failed) return;
      }

      // null settlement means this generation was deleted or superseded while embedding.
      // Claim once more: a queued successor is processed here; a deleted document ends the job.
    }
  }

  async function processDocument(documentId) {
    if (disposed) return undefined;
    if (processingJobs.has(documentId)) return processingJobs.get(documentId);

    const job = processLatestGeneration(documentId).finally(() => {
      processingJobs.delete(documentId);
    });
    processingJobs.set(documentId, job);
    return job;
  }

  function enqueue(documentIds) {
    if (disposed) return;
    for (const documentId of new Set(documentIds)) {
      try {
        scheduleTask(() => processDocument(documentId));
      } catch (error) {
        logger.error?.(`[knowledge] failed to schedule ${documentId}: ${error?.message || error}`);
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    disposed = false;
    unsubscribe = store.subscribeQueuedDocuments(enqueue);
    enqueue(
      store.listDocumentsByStatus(['queued', 'processing'])
        .map((document) => document.id)
    );
  }

  async function dispose() {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    await Promise.allSettled([...processingJobs.values()]);
    processingJobs.clear();
    started = false;
  }

  return { start, dispose };
}
