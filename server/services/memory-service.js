import {
  buildPitfallDetailsFromContent,
  buildMemorySearchText,
  containsSensitiveMemory,
  findSemanticDuplicate,
  normalizeMemoryCandidate,
  rankMemories
} from '../memory-utils.js';
import { createMemoryFingerprint } from '../memory-store.js';

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

function serializeMemory(memory) {
  const sourceExcerpt = memory.sourceExcerpt || '';
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    details: memory.details || {},
    confidence: memory.confidence,
    status: memory.status,
    sourceConversationId: memory.sourceConversationId || '',
    sourceMessageIds: memory.sourceMessageIds || [],
    sourceExcerpt: sourceExcerpt.slice(0, 4000),
    sourceExcerptTruncated: sourceExcerpt.length > 4000,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    confirmedAt: memory.confirmedAt || null,
    score: typeof memory.score === 'number' ? memory.score : undefined
  };
}

export function createMemoryService({
  store,
  embeddingClient,
  embeddingModel,
  idFactory = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  now = () => Date.now(),
  logger = console
}) {
  const state = { memories: store.listAllMemories() };
  const storedModel = store.getMetadata('embedding_model');
  const embeddedCount = state.memories.filter((memory) => memory.embedding?.length).length;
  let embeddingCompatible;
  if (!storedModel || embeddedCount === 0) {
    store.setMetadata('embedding_model', embeddingModel);
    embeddingCompatible = true;
  } else {
    embeddingCompatible = storedModel === embeddingModel;
  }

  function reloadState() {
    state.memories = store.listAllMemories();
    if (!state.memories.some((memory) => memory.embedding?.length)) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }
  }

  async function searchMemories(query, topK = 4, { types, signal } = {}) {
    const safeQuery = String(query || '').slice(0, 4000);
    const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
    const retrievable = state.memories.filter((memory) =>
      (memory.status === 'confirmed' || memory.status === 'corrected') &&
      (!typeSet || typeSet.has(memory.type))
    );
    if (!retrievable.length) return [];

    let queryEmbedding = [];
    try {
      if (!embeddingCompatible) {
        throw createServiceError(
          'EMBEDDING_MODEL_CHANGED',
          'Embedding 模型已变更，记忆向量需要重建',
          '当前记忆召回已降级为关键词模式。',
          409
        );
      }
      queryEmbedding = await embeddingClient.embed(safeQuery, { signal });
    } catch (error) {
      logger.error?.(`[memory] vector retrieval unavailable: ${error?.message || error}`);
    }
    return rankMemories(
      safeQuery,
      retrievable.map((memory) => ({
        ...memory,
        vectorScore: cosineSimilarity(queryEmbedding, memory.embedding)
      })),
      topK
    ).map(serializeMemory);
  }

  async function createMemoryEmbedding(text, signal) {
    try {
      return await embeddingClient.embed(text, { signal });
    } catch (error) {
      if (error?.code === 'REQUEST_ABORTED') throw error;
      logger.error?.(
        `[memory] embedding unavailable, using lexical fallback: ${error?.message || error}`
      );
      return [];
    }
  }

  async function persistMemory(input, status, signal) {
    const candidate = normalizeMemoryCandidate(input);
    if (!candidate) {
      throw createServiceError(
        'INVALID_MEMORY',
        '记忆候选内容不完整',
        '至少需要包含类型、标题和完整内容。',
        400
      );
    }
    if (containsSensitiveMemory(input.sourceExcerpt || '')) {
      throw createServiceError(
        'SENSITIVE_MEMORY',
        '记忆候选包含敏感信息，已阻止保存',
        '请移除密码、密钥、身份号码或联系方式后再试。',
        400
      );
    }
    if (!state.memories.some((memory) => memory.embedding?.length)) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }

    const proposed = {
      ...candidate,
      details: { ...candidate.details, tags: candidate.tags || [] },
      status,
      sourceConversationId: input.sourceConversationId || '',
      sourceMessageIds: input.sourceMessageIds || [],
      sourceExcerpt: input.sourceExcerpt || ''
    };
    const fingerprint = createMemoryFingerprint(proposed);
    const exactDuplicate = store.findByFingerprint(fingerprint);
    if (exactDuplicate) {
      const memory = status === 'confirmed' && exactDuplicate.status === 'candidate'
        ? await updateMemory(exactDuplicate.id, { status: 'confirmed' }, signal)
        : serializeMemory(exactDuplicate);
      return { memory, duplicate: true };
    }

    const embedding = embeddingCompatible
      ? await createMemoryEmbedding(buildMemorySearchText(proposed), signal)
      : [];
    const semanticDuplicate = embedding.length
      ? findSemanticDuplicate(
          embedding,
          state.memories.filter(
            (memory) => memory.status !== 'rejected' && memory.type === proposed.type
          )
        )
      : null;
    if (semanticDuplicate) {
      const memory = status === 'confirmed' && semanticDuplicate.status === 'candidate'
        ? await updateMemory(semanticDuplicate.id, {
            type: proposed.type,
            title: proposed.title,
            content: proposed.content,
            details: proposed.details,
            confidence: proposed.confidence,
            status: 'confirmed'
          }, signal)
        : serializeMemory(semanticDuplicate);
      return { memory, duplicate: true };
    }

    const timestamp = now();
    const memory = store.insertMemory({
      id: idFactory('memory'),
      ...proposed,
      fingerprint,
      embedding,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    reloadState();
    return { memory: serializeMemory(memory), duplicate: false };
  }

  async function proposeMemory(input, signal) {
    return persistMemory(input, 'candidate', signal);
  }

  async function createMemory(input, signal) {
    return persistMemory(input, 'confirmed', signal);
  }

  async function updateMemory(id, patch, signal) {
    const existing = store.getMemory(id);
    if (!existing) throw createServiceError('MEMORY_NOT_FOUND', '记忆不存在', '', 404);
    if (!state.memories.some((memory) => memory.embedding?.length)) {
      store.setMetadata('embedding_model', embeddingModel);
      embeddingCompatible = true;
    }
    const effectivePatch = { ...patch };
    const nextType = effectivePatch.type || existing.type;
    if (
      nextType === 'pitfall' &&
      !Object.hasOwn(effectivePatch, 'details') &&
      (Object.hasOwn(effectivePatch, 'content') || existing.type !== 'pitfall')
    ) {
      effectivePatch.details = buildPitfallDetailsFromContent(
        effectivePatch.content ?? existing.content,
        existing.details?.tags || []
      );
    } else if (
      existing.type === 'pitfall' &&
      nextType !== 'pitfall' &&
      !Object.hasOwn(effectivePatch, 'details')
    ) {
      effectivePatch.details = {};
    }

    const contentChanged = ['type', 'title', 'content', 'details'].some(
      (key) => Object.hasOwn(effectivePatch, key)
    );
    const shouldBackfillEmbedding =
      !existing.embedding?.length &&
      (effectivePatch.status === 'confirmed' || effectivePatch.status === 'corrected');
    let embedding = existing.embedding;
    let fingerprint = existing.fingerprint;
    if (contentChanged || shouldBackfillEmbedding) {
      const merged = {
        ...existing,
        ...effectivePatch,
        details: Object.hasOwn(effectivePatch, 'details')
          ? effectivePatch.details
          : existing.details
      };
      if (containsSensitiveMemory({
        type: merged.type,
        title: merged.title,
        content: merged.content,
        details: merged.details
      })) {
        throw createServiceError(
          'SENSITIVE_MEMORY',
          '记忆内容包含敏感信息，已阻止更新',
          '请移除密码、密钥、身份号码或联系方式后再试。',
          400
        );
      }
      embedding = embeddingCompatible
        ? await createMemoryEmbedding(buildMemorySearchText(merged), signal)
        : [];
      fingerprint = createMemoryFingerprint(merged);
    }
    const memory = store.updateMemory(id, {
      ...effectivePatch,
      embedding,
      fingerprint
    });
    reloadState();
    return serializeMemory(memory);
  }

  function listMemories(filters = {}) {
    return store.listMemories(filters).map(serializeMemory);
  }

  function countMemories(filters = {}) {
    return store.countMemories(filters);
  }

  function deleteMemory(id) {
    const result = store.deleteMemory(id);
    reloadState();
    return result;
  }

  return {
    searchMemories,
    proposeMemory,
    createMemory,
    updateMemory,
    listMemories,
    countMemories,
    deleteMemory
  };
}
