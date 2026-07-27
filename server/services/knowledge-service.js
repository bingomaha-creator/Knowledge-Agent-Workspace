import { rankKnowledgeChunks } from '../rag-utils.js';

function createServiceError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function normalizeKnowledgeScope(knowledgeBaseIds) {
  if (!Array.isArray(knowledgeBaseIds)) return null;
  return [...new Set(knowledgeBaseIds.filter((id) => typeof id === 'string' && id.trim()))]
    .map((id) => id.trim())
    .slice(0, 20);
}

function serializeKnowledgeDocument(document) {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId || 'kb-default',
    name: document.name,
    status: document.status || 'ready',
    error: document.error || '',
    publicationStatus: document.publicationStatus || 'published',
    publishedAt: document.publishedAt || null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt || document.createdAt
  };
}

export function createKnowledgeService({
  store,
  embeddingClient,
  embeddingModel,
  rankKnowledgeChunksImpl = rankKnowledgeChunks,
  idFactory = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  now = () => Date.now(),
  logger = console
}) {
  const storedModel = store.getMetadata('embedding_model');
  let embeddingCompatible;
  if (!storedModel || !store.hasStoredChunks()) {
    store.setMetadata('embedding_model', embeddingModel);
    embeddingCompatible = true;
  } else {
    embeddingCompatible = storedModel === embeddingModel;
  }

  const loadCurrentState = () => store.loadState();

  function requireDocument(id, knowledgeBaseId) {
    const document = store.getDocument(id);
    if (!document || (knowledgeBaseId && document.knowledgeBaseId !== knowledgeBaseId)) {
      throw createServiceError(
        'DOCUMENT_NOT_FOUND',
        '知识文件不存在',
        '请确认传入的文档 ID 是否正确。',
        404
      );
    }
    return document;
  }

  function buildCitation(chunk, score) {
    const headingPath = Array.isArray(chunk.headingPath) ? chunk.headingPath : [];
    const section = headingPath.length ? ` / ${headingPath.join(' / ')}` : '';
    const retrieval = chunk.retrieval || {};
    const knowledgeBaseId = chunk.knowledgeBaseId || 'kb-default';
    const knowledgeBase = store.getKnowledgeBase(knowledgeBaseId);
    return {
      id: chunk.id,
      title: chunk.documentName,
      documentId: chunk.documentId,
      knowledgeBaseId,
      knowledgeBaseName: knowledgeBase?.name || '默认知识库',
      snippet: chunk.text,
      source: `混合检索知识库 / ${knowledgeBase?.name || '默认知识库'} / ${chunk.documentName}${section}`,
      headingPath,
      score: Number(score.toFixed(4)),
      retrieval: {
        sources: retrieval.sources || [],
        vectorRank: retrieval.vectorRank,
        keywordRank: retrieval.keywordRank,
        vectorScore: typeof retrieval.vectorScore === 'number'
          ? Number(retrieval.vectorScore.toFixed(4))
          : undefined,
        bm25Score: typeof retrieval.bm25Score === 'number'
          ? Number(retrieval.bm25Score.toFixed(4))
          : undefined,
        rrfScore: retrieval.rrfScore
      }
    };
  }

  async function retrieveChunkCandidates(query, limit = 20, knowledgeBaseIds, signal) {
    const scope = normalizeKnowledgeScope(knowledgeBaseIds);
    const { chunks } = loadCurrentState();
    const eligibleChunks = scope
      ? chunks.filter((chunk) => scope.includes(chunk.knowledgeBaseId || 'kb-default'))
      : chunks;
    if (!eligibleChunks.length) {
      return { keyword: [], vector: [], degradedChannels: [] };
    }

    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 20));
    const chunksById = new Map(eligibleChunks.map((chunk) => [chunk.id, chunk]));
    const keyword = store.searchChunksByKeyword(
      query,
      boundedLimit,
      scope === null ? undefined : { knowledgeBaseIds: scope }
    ).flatMap((match) => {
      const chunk = chunksById.get(match.chunkId);
      return chunk ? [{
        documentId: chunk.documentId,
        chunk,
        rank: match.rank,
        bm25Score: match.bm25Score
      }] : [];
    });

    let queryEmbedding;
    try {
      if (!embeddingCompatible) {
        throw createServiceError(
          'EMBEDDING_MODEL_CHANGED',
          'Embedding 模型已变更，向量索引需要重建',
          '',
          409
        );
      }
      queryEmbedding = await embeddingClient.embed(query, { signal });
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
      logger.error?.(`[knowledge] vector candidate retrieval unavailable: ${error?.message || error}`);
      return { keyword, vector: [], degradedChannels: ['vector'] };
    }

    // Store 的 SQL eligibility 过滤发生在当前快照加载时，因此这里的截断不会让
    // candidate/rejected BugCase 抢占向量候选名额。
    const vector = eligibleChunks
      .map((chunk) => ({
        documentId: chunk.documentId,
        chunk,
        vectorScore: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .filter((match) => Number.isFinite(match.vectorScore))
      .sort((left, right) =>
        right.vectorScore - left.vectorScore
        || left.chunk.id.localeCompare(right.chunk.id)
      )
      .slice(0, boundedLimit)
      .map((match, index) => ({ ...match, rank: index + 1 }));

    return { keyword, vector, degradedChannels: [] };
  }

  async function searchKnowledge(query, topK = 4, knowledgeBaseIds, signal) {
    const scope = normalizeKnowledgeScope(knowledgeBaseIds);
    const { chunks } = loadCurrentState();
    const scopedChunks = scope
      ? chunks.filter((chunk) => scope.includes(chunk.knowledgeBaseId || 'kb-default'))
      : chunks;
    if (!scopedChunks.length) return { citations: [], trace: null };

    const candidateLimit = Math.max(topK * 5, 20);
    const keywordMatches = store.searchChunksByKeyword(
      query,
      candidateLimit,
      scope === null ? undefined : { knowledgeBaseIds: scope }
    );
    const keywordByChunkId = new Map(
      keywordMatches.map((match) => [match.chunkId, match])
    );
    let queryEmbedding = [];
    let embeddingError = null;
    try {
      if (!embeddingCompatible) {
        throw createServiceError(
          'EMBEDDING_MODEL_CHANGED',
          'Embedding 模型已变更，向量索引需要重建',
          '当前检索已降级为关键词模式；请清空并重新导入知识文档以恢复向量检索。',
          409
        );
      }
      queryEmbedding = await embeddingClient.embed(query, { signal });
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
      embeddingError = {
        code: error?.code || 'EMBEDDING_UNAVAILABLE',
        message: error?.message || 'Embedding 不可用'
      };
      logger.error?.(`[knowledge] vector retrieval unavailable: ${embeddingError.message}`);
    }

    const ranked = rankKnowledgeChunksImpl(
      query,
      scopedChunks.map((chunk) => ({
        ...chunk,
        vectorScore: cosineSimilarity(queryEmbedding, chunk.embedding),
        keywordRank: keywordByChunkId.get(chunk.id)?.rank,
        bm25Score: keywordByChunkId.get(chunk.id)?.bm25Score
      })),
      topK,
      { includeTrace: true, candidateLimit }
    );
    return {
      citations: ranked.results.map((chunk) => buildCitation(chunk, chunk.score)),
      trace: {
        ...ranked.trace,
        embedding: embeddingError
          ? { ok: false, model: embeddingModel, ...embeddingError }
          : { ok: true, model: embeddingModel, dimensions: queryEmbedding.length }
      }
    };
  }

  async function ingestDocuments(documents, knowledgeBaseId = 'kb-default') {
    const hasStoredChunks = store.hasStoredChunks();
    if (!embeddingCompatible && hasStoredChunks) {
      throw createServiceError(
        'EMBEDDING_MODEL_CHANGED',
        'Embedding 模型已变更，暂时不能追加文档',
        '请先清空并重新导入知识文档，避免混用不同模型生成的向量。',
        409
      );
    }
    if (!hasStoredChunks) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }
    if (!store.getKnowledgeBase(knowledgeBaseId)) {
      throw createServiceError(
        'KNOWLEDGE_BASE_NOT_FOUND',
        '知识库不存在',
        '请刷新知识库列表后重试。',
        404
      );
    }

    const supported = documents.filter((document) =>
      /\.(txt|md|markdown|json)$/i.test(document.name)
    );
    if (!supported.length) {
      throw createServiceError(
        'UNSUPPORTED_FILES',
        '没有可导入的知识文件',
        '仅支持 `.md`、`.markdown`、`.txt`、`.json` 文件。',
        400
      );
    }

    const nextDocuments = supported
      .map((source) => ({ source, content: source.content.trim() }))
      .filter(({ content }) => content)
      .map(({ source, content }) => ({
        id: idFactory('doc'),
        knowledgeBaseId,
        name: source.name,
        content,
        status: 'queued',
        error: '',
        publicationStatus: 'draft',
        publishedAt: null,
        createdAt: now(),
        updatedAt: now()
      }));
    if (!nextDocuments.length) {
      throw createServiceError(
        'EMPTY_FILES',
        '上传的文件内容为空',
        '请确认文件不是空文件，且编码为 UTF-8。',
        400
      );
    }

    store.insertQueuedDocuments(nextDocuments);
    return nextDocuments.map(serializeKnowledgeDocument);
  }

  function listDocuments(knowledgeBaseIds, statuses) {
    const scope = normalizeKnowledgeScope(knowledgeBaseIds);
    const allowedStatuses = Array.isArray(statuses) ? new Set(statuses) : null;
    return loadCurrentState().documents
      // BugCase 有独立管理 API；这里保持既有 generic 文档合同，避免旧界面可误删系统案例。
      .filter((document) => (document.documentType || 'generic') === 'generic')
      .filter((document) => !scope || scope.includes(document.knowledgeBaseId || 'kb-default'))
      .filter((document) => !allowedStatuses || allowedStatuses.has(document.status || 'ready'))
      .map(serializeKnowledgeDocument);
  }

  function deleteDocument(id, knowledgeBaseId) {
    requireDocument(id, knowledgeBaseId);
    store.deleteDocument(id, knowledgeBaseId ? { knowledgeBaseId } : undefined);
    return { ok: true, id };
  }

  function getDocumentPreview(id, knowledgeBaseId) {
    const document = requireDocument(id, knowledgeBaseId);
    const chunks = store.listDocumentChunks(id);
    const content = String(document.content || '').trim();
    const excerptLimit = 12_000;
    const headings = [...new Set(
      chunks
        .map((chunk) => Array.isArray(chunk.headingPath) ? chunk.headingPath.join(' / ') : '')
        .filter(Boolean)
    )].slice(0, 30);
    return {
      document: serializeKnowledgeDocument(document),
      preview: {
        excerpt: content.slice(0, excerptLimit),
        truncated: content.length > excerptLimit,
        characterCount: content.length,
        chunkCount: chunks.length,
        headings
      }
    };
  }

  function publishDocument(id, knowledgeBaseId) {
    requireDocument(id, knowledgeBaseId);
    return serializeKnowledgeDocument(store.publishDocument(id, now()));
  }

  function withdrawDocument(id, knowledgeBaseId) {
    requireDocument(id, knowledgeBaseId);
    return serializeKnowledgeDocument(store.withdrawDocument(id, now()));
  }

  function clearDocuments(knowledgeBaseId) {
    store.clearDocuments(knowledgeBaseId ? { knowledgeBaseId } : undefined);
    if (!store.hasStoredChunks()) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }
    return { ok: true, knowledgeBaseId: knowledgeBaseId || null };
  }

  function listKnowledgeBases() {
    const counts = new Map();
    for (const document of loadCurrentState().documents) {
      const id = document.knowledgeBaseId || 'kb-default';
      const current = counts.get(id) || { total: 0, published: 0, draft: 0 };
      current.total += 1;
      if (document.publicationStatus === 'draft') current.draft += 1;
      if (document.publicationStatus === 'published' && document.status === 'ready') {
        current.published += 1;
      }
      counts.set(id, current);
    }
    return store.listKnowledgeBases().map((base) => ({
      ...base,
      documentCount: counts.get(base.id)?.total || 0,
      publishedDocumentCount: counts.get(base.id)?.published || 0,
      draftDocumentCount: counts.get(base.id)?.draft || 0
    }));
  }

  function createKnowledgeBase(input) {
    const name = input.name.trim();
    if (listKnowledgeBases().some((base) => base.name.toLowerCase() === name.toLowerCase())) {
      throw createServiceError(
        'KNOWLEDGE_BASE_NAME_CONFLICT',
        '知识库名称已存在',
        '请换一个名称。',
        409
      );
    }
    const timestamp = now();
    return {
      ...store.createKnowledgeBase({
        id: idFactory('kb'),
        name,
        description: (input.description || '').trim(),
        createdAt: timestamp,
        updatedAt: timestamp
      }),
      documentCount: 0,
      publishedDocumentCount: 0,
      draftDocumentCount: 0
    };
  }

  function updateKnowledgeBase(id, input) {
    if (
      typeof input.name === 'string' &&
      listKnowledgeBases().some(
        (base) => base.id !== id && base.name.toLowerCase() === input.name.trim().toLowerCase()
      )
    ) {
      throw createServiceError(
        'KNOWLEDGE_BASE_NAME_CONFLICT',
        '知识库名称已存在',
        '请换一个名称。',
        409
      );
    }
    const updated = store.updateKnowledgeBase(id, {
      name: typeof input.name === 'string' ? input.name.trim() : undefined,
      description: typeof input.description === 'string'
        ? input.description.trim()
        : undefined,
      updatedAt: now()
    });
    if (!updated) {
      throw createServiceError(
        'KNOWLEDGE_BASE_NOT_FOUND',
        '知识库不存在',
        '请刷新列表后重试。',
        404
      );
    }
    return listKnowledgeBases().find((base) => base.id === id) || {
      ...updated,
      documentCount: 0,
      publishedDocumentCount: 0,
      draftDocumentCount: 0
    };
  }

  function deleteKnowledgeBase(id, force = false) {
    const result = store.deleteKnowledgeBase(id, { force });
    if (!store.hasStoredChunks()) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }
    return result;
  }

  return {
    searchKnowledge,
    retrieveChunkCandidates,
    ingestDocuments,
    listDocuments,
    getDocumentPreview,
    publishDocument,
    withdrawDocument,
    deleteDocument,
    clearDocuments,
    listKnowledgeBases,
    createKnowledgeBase,
    updateKnowledgeBase,
    deleteKnowledgeBase
  };
}
