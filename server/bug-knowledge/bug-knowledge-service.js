import {
  BUG_CASE_CONTENT_FIELDS,
  buildBugCaseFingerprint,
  normalizeBugCaseContent,
  normalizeBugCasePatch,
  renderBugCaseDocument,
  validateBugCaseConfirmation
} from './bug-case-domain.js';
import { createBugQuery, matchExactBugSignatures } from './bug-query.js';
import { rankBugCases } from './bug-ranker.js';
import { COMMON_BUG_KNOWLEDGE_BASE_ID } from '../knowledge-store.js';
import { expandCjkBigrams } from '../rag-utils.js';

function createServiceError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function normalizeProjectText(value, field, maxLength, { required = false } = {}) {
  if (value !== undefined && typeof value !== 'string') {
    throw createServiceError('BUG_PROJECT_INVALID_FIELD', `${field} 必须是字符串`, 400);
  }
  const normalized = String(value || '').trim();
  if (required && !normalized) {
    throw createServiceError('BUG_PROJECT_FIELD_REQUIRED', `${field} 不能为空`, 422);
  }
  if (normalized.length > maxLength) {
    throw createServiceError(
      'BUG_PROJECT_FIELD_TOO_LONG',
      `${field} 不能超过 ${maxLength} 个字符`,
      422
    );
  }
  return normalized;
}

function serializeProject(project, bugCaseCount = 0) {
  return {
    projectRef: project.projectRef,
    knowledgeBaseId: project.id,
    name: project.name,
    description: project.description,
    kind: project.kind,
    bugCaseCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function contentFromMetadata(metadata = {}) {
  return Object.fromEntries(
    BUG_CASE_CONTENT_FIELDS.map((field) => [field, metadata[field]])
  );
}

function serializeBugCase(document, store) {
  const content = normalizeBugCaseContent(contentFromMetadata(document.metadata));
  const knowledgeBase = store.getKnowledgeBase(document.knowledgeBaseId);
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId,
    scope: knowledgeBase?.kind === 'common_bugs' ? 'common' : 'project',
    sourceProjectRef: document.metadata.sourceProjectRef,
    ...content,
    fingerprint: document.metadata.fingerprint || buildBugCaseFingerprint(content),
    status: document.status,
    error: document.error,
    reviewStatus: document.reviewStatus,
    reviewedBy: document.metadata.reviewedBy || null,
    reviewReason: document.metadata.reviewReason || null,
    reviewedAt: Number.isFinite(document.metadata.reviewedAt)
      ? document.metadata.reviewedAt
      : null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

function metadataFor(content, sourceProjectRef, review = {}) {
  return {
    ...content,
    sourceProjectRef,
    fingerprint: buildBugCaseFingerprint(content),
    reviewedBy: review.reviewedBy || null,
    reviewReason: review.reviewReason || null,
    reviewedAt: Number.isFinite(review.reviewedAt) ? review.reviewedAt : null
  };
}

function requireReviewReason(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createServiceError('BUG_CASE_REVIEW_REASON_REQUIRED', 'reviewReason 不能为空', 422);
  }
  const reason = value.trim();
  if (reason.length > 2_000) {
    throw createServiceError(
      'BUG_CASE_REVIEW_REASON_TOO_LONG',
      'reviewReason 不能超过 2000 个字符',
      422
    );
  }
  return reason;
}

function bugCaseMatchesFilters(bugCase, filters) {
  const context = bugCase.context || {};
  for (const field of ['language', 'framework']) {
    if (!filters[field]) continue;
    if (String(context[field] || '').trim().toLocaleLowerCase('en-US') !== filters[field]) {
      return false;
    }
  }
  if (filters.versions.length) {
    const versions = new Set(
      (context.versions || []).map((value) => String(value).trim().toLocaleLowerCase('en-US'))
    );
    if (!filters.versions.some((version) => versions.has(version))) return false;
  }
  if (filters.tags.length) {
    const tags = new Set(
      (bugCase.tags || []).map((value) => String(value).trim().toLocaleLowerCase('en-US'))
    );
    if (!filters.tags.every((tag) => tags.has(tag))) return false;
  }
  return true;
}

function meaningfulQueryTokens(tokens) {
  return [...new Set(
    expandCjkBigrams(tokens)
      .map((token) => String(token).toLocaleLowerCase('en-US'))
      .filter((token) => token.length >= 3 || /[\u3400-\u9fff]/u.test(token))
  )];
}

function hasLexicalAnchor(match, queryTokens) {
  const anchors = meaningfulQueryTokens(queryTokens);
  if (!anchors.length) return false;
  const chunkTokens = new Set(
    expandCjkBigrams(match.chunk.tokens || [])
      .map((token) => String(token).toLocaleLowerCase('en-US'))
  );
  const overlap = anchors.filter((token) => chunkTokens.has(token)).length;
  // 单词/错误码查询允许一个强锚点；较长粘贴内容至少要有两个锚点，防止仅凭 “vite”
  // 这类通用词把另一个项目的无关案例误报成证据。
  return overlap >= Math.min(2, anchors.length);
}

function selectMeaningfulVectorMatches(vectorMatches, hasLexicalEvidence, queryTokens = []) {
  const strong = vectorMatches.filter((match) => match.vectorScore >= 0.55);
  if (hasLexicalEvidence || !strong.length) return strong;
  const anchored = strong.filter((match) => hasLexicalAnchor(match, queryTokens));
  if (!anchored.length) return [];
  // 纯向量命中需要“高分且与第二名拉开差距”。否则相似度空间里的普遍正相关会让任意文本
  // 都返回一个貌似精确的 BugCase；这种情况应明确报告 evidence gap。
  const top = anchored[0]?.vectorScore || 0;
  const second = anchored[1]?.vectorScore || 0;
  return top >= 0.82 && (anchored.length === 1 || top - second >= 0.03)
    ? anchored
    : [];
}

/**
 * BugKnowledgeService 是 BugCase 的应用层状态机。Store 负责单个 SQLite 事务，
 * KnowledgeIndexLifecycle 自动处理 queued mutation；这里仅依赖共享 Knowledge retrieval。
 */
export function createBugKnowledgeService({
  store,
  knowledgeRetrieval,
  idFactory = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  now = () => Date.now()
}) {
  if (!store) throw new TypeError('BugKnowledgeService requires store');
  if (!knowledgeRetrieval) {
    throw new TypeError('BugKnowledgeService requires knowledgeRetrieval');
  }

  function listProjects() {
    const counts = new Map();
    for (const document of store.listBugCaseDocuments?.() || []) {
      counts.set(
        document.metadata.sourceProjectRef,
        (counts.get(document.metadata.sourceProjectRef) || 0) + 1
      );
    }
    return store.listBugProjects().map((project) =>
      serializeProject(project, counts.get(project.projectRef) || 0)
    );
  }

  function createProject(input = {}) {
    // 客户端只能提供显示字段；稳定身份和系统库 ID 均由服务端生成，避免伪造/碰撞。
    const name = normalizeProjectText(input.name, 'name', 80, { required: true });
    const description = normalizeProjectText(input.description, 'description', 500);
    const timestamp = now();
    const created = store.createBugProject({
      projectRef: idFactory('project'),
      knowledgeBaseId: idFactory('kb-project'),
      name,
      description,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return serializeProject(created);
  }

  function updateProject(projectRef, input = {}) {
    const ref = String(projectRef || '').trim();
    if (!ref) throw createServiceError('BUG_PROJECT_REF_REQUIRED', 'projectRef 不能为空', 400);
    for (const field of Object.keys(input)) {
      if (!['name', 'description'].includes(field)) {
        throw createServiceError(
          'BUG_PROJECT_IMMUTABLE_IDENTITY',
          `项目字段 ${field} 不允许修改`,
          400
        );
      }
    }
    const updated = store.updateBugProject(ref, {
      ...(input.name !== undefined
        ? { name: normalizeProjectText(input.name, 'name', 80, { required: true }) }
        : {}),
      ...(input.description !== undefined
        ? { description: normalizeProjectText(input.description, 'description', 500) }
        : {}),
      updatedAt: now()
    });
    if (!updated) {
      throw createServiceError('BUG_PROJECT_NOT_FOUND', 'Bug 项目不存在', 404);
    }
    const count = (store.listBugCaseDocuments?.() || []).filter(
      (document) => document.metadata.sourceProjectRef === ref
    ).length;
    return serializeProject(updated, count);
  }

  function listBugCases(filters = {}) {
    const reviewStatuses = Array.isArray(filters.reviewStatuses)
      ? new Set(filters.reviewStatuses)
      : filters.reviewStatus
        ? new Set([filters.reviewStatus])
        : null;
    const processingStatuses = Array.isArray(filters.statuses)
      ? new Set(filters.statuses)
      : null;
    const knowledgeBaseIds = Array.isArray(filters.knowledgeBaseIds)
      ? new Set(filters.knowledgeBaseIds)
      : null;
    return store.listBugCaseDocuments()
      .map((document) => serializeBugCase(document, store))
      .filter((bugCase) =>
        !filters.sourceProjectRef || bugCase.sourceProjectRef === filters.sourceProjectRef
      )
      .filter((bugCase) => !filters.scope || bugCase.scope === filters.scope)
      .filter((bugCase) => !reviewStatuses || reviewStatuses.has(bugCase.reviewStatus))
      .filter((bugCase) => !processingStatuses || processingStatuses.has(bugCase.status))
      .filter((bugCase) => !knowledgeBaseIds || knowledgeBaseIds.has(bugCase.knowledgeBaseId));
  }

  function getBugCase(id) {
    const document = store.getBugCaseDocument(String(id || '').trim());
    if (!document) throw createServiceError('BUG_CASE_NOT_FOUND', 'BugCase 不存在', 404);
    return serializeBugCase(document, store);
  }

  function createBugCase(input = {}) {
    const sourceProjectRef = typeof input.sourceProjectRef === 'string'
      ? input.sourceProjectRef.trim()
      : '';
    if (!sourceProjectRef) {
      throw createServiceError('BUG_PROJECT_REF_REQUIRED', 'sourceProjectRef 不能为空', 422);
    }
    const project = store.getBugProject(sourceProjectRef);
    if (!project) throw createServiceError('BUG_PROJECT_NOT_FOUND', 'Bug 项目不存在', 404);

    const { sourceProjectRef: _sourceProjectRef, ...untrustedContent } = input;
    // reviewStatus/reviewedBy 若混入创建 DTO，会作为未知内容字段被 domain 明确拒绝。
    const content = normalizeBugCaseContent(untrustedContent);
    const timestamp = now();
    const document = store.insertBugCaseDocument({
      id: idFactory('bug-case'),
      knowledgeBaseId: project.id,
      name: `${content.title}.bug.md`,
      content: renderBugCaseDocument(content),
      metadata: metadataFor(content, sourceProjectRef),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return serializeBugCase(document, store);
  }

  function updateBugCase(id, patch = {}) {
    const currentDocument = store.getBugCaseDocument(String(id || '').trim());
    if (!currentDocument) throw createServiceError('BUG_CASE_NOT_FOUND', 'BugCase 不存在', 404);
    const currentContent = normalizeBugCaseContent(contentFromMetadata(currentDocument.metadata));
    const nextContent = normalizeBugCasePatch(currentContent, patch);

    // 规格要求“实质编辑”才退审。归一化后完全相同的 patch 不启动无意义的重建作业。
    if (JSON.stringify(nextContent) === JSON.stringify(currentContent)) {
      return serializeBugCase(currentDocument, store);
    }

    const updated = store.updateBugCaseContent(currentDocument.id, {
      name: `${nextContent.title}.bug.md`,
      content: renderBugCaseDocument(nextContent),
      metadata: metadataFor(nextContent, currentDocument.metadata.sourceProjectRef),
      updatedAt: now()
    });
    return serializeBugCase(updated, store);
  }

  function deleteBugCase(id) {
    const normalizedId = String(id || '').trim();
    if (!store.getBugCaseDocument(normalizedId)) {
      throw createServiceError('BUG_CASE_NOT_FOUND', 'BugCase 不存在', 404);
    }
    store.deleteBugCaseDocument(normalizedId);
    return { ok: true, id: normalizedId };
  }

  function reviewBugCase(id, input = {}) {
    const current = store.getBugCaseDocument(String(id || '').trim());
    if (!current) throw createServiceError('BUG_CASE_NOT_FOUND', 'BugCase 不存在', 404);
    if (current.status !== 'ready') {
      throw createServiceError(
        'BUG_CASE_NOT_READY',
        'BugCase 只有完成索引处理后才能审核',
        409
      );
    }
    const nextStatus = input.reviewStatus;
    if (!['confirmed', 'rejected'].includes(nextStatus)) {
      throw createServiceError(
        'BUG_CASE_INVALID_REVIEW_STATUS',
        'reviewStatus 只能是 confirmed 或 rejected',
        422
      );
    }
    const transitionAllowed = (
      current.reviewStatus === 'candidate'
      || (current.reviewStatus === 'confirmed' && nextStatus === 'rejected')
    );
    if (!transitionAllowed) {
      throw createServiceError(
        'BUG_CASE_INVALID_REVIEW_TRANSITION',
        `${current.reviewStatus} 不能直接变为 ${nextStatus}`,
        409
      );
    }

    const content = normalizeBugCaseContent(contentFromMetadata(current.metadata));
    if (nextStatus === 'confirmed') validateBugCaseConfirmation(content);
    const reviewedAt = now();
    const updated = store.reviewBugCaseDocument(current.id, {
      reviewStatus: nextStatus,
      metadata: metadataFor(content, current.metadata.sourceProjectRef, {
        // 当前是本地单用户产品；身份由服务端固定，绝不读取 input.reviewedBy。
        reviewedBy: 'local-user',
        reviewReason: requireReviewReason(input.reviewReason),
        reviewedAt
      }),
      updatedAt: reviewedAt
    });
    return serializeBugCase(updated, store);
  }

  function promoteBugCase(id) {
    const current = store.getBugCaseDocument(String(id || '').trim());
    if (!current) throw createServiceError('BUG_CASE_NOT_FOUND', 'BugCase 不存在', 404);
    const sourceBase = store.getKnowledgeBase(current.knowledgeBaseId);
    if (
      current.status !== 'ready'
      || current.reviewStatus !== 'confirmed'
      || sourceBase?.kind !== 'project_bugs'
    ) {
      throw createServiceError(
        'BUG_CASE_NOT_PROMOTABLE',
        '只有项目库中 ready + confirmed 的 BugCase 可以提升到公共库',
        409
      );
    }
    const promoted = store.promoteBugCaseDocument(current.id, now());
    return serializeBugCase(promoted, store);
  }

  async function searchBugCases(input = {}, signal) {
    const query = createBugQuery(input);
    if (
      input.topK !== undefined
      && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20)
    ) {
      throw createServiceError(
        'BUG_SEARCH_INVALID_TOP_K',
        'topK 必须是 1–20 的整数',
        422
      );
    }
    if (input.includeCommon !== undefined && typeof input.includeCommon !== 'boolean') {
      throw createServiceError(
        'BUG_SEARCH_INVALID_COMMON_SCOPE',
        'includeCommon 必须是布尔值',
        400
      );
    }
    const projectRef = typeof input.projectRef === 'string' ? input.projectRef.trim() : '';
    if (!projectRef) {
      throw createServiceError('BUG_PROJECT_REF_REQUIRED', 'projectRef 不能为空', 422);
    }
    const currentProject = store.getBugProject(projectRef);
    if (!currentProject) throw createServiceError('BUG_PROJECT_NOT_FOUND', 'Bug 项目不存在', 404);

    if (
      input.additionalProjectRefs !== undefined
      && !Array.isArray(input.additionalProjectRefs)
    ) {
      throw createServiceError(
        'BUG_SEARCH_INVALID_ADDITIONAL_PROJECTS',
        'additionalProjectRefs 必须是数组',
        400
      );
    }
    if ((input.additionalProjectRefs || []).length > 20) {
      throw createServiceError(
        'BUG_SEARCH_TOO_MANY_ADDITIONAL_PROJECTS',
        'additionalProjectRefs 最多包含 20 个项目',
        422
      );
    }
    const additionalRefs = [...new Set(
      (input.additionalProjectRefs || [])
        .map((value) => String(value || '').trim())
        .filter((value) => value && value !== projectRef)
    )].slice(0, 20);
    const additionalProjects = additionalRefs.map((ref) => {
      const project = store.getBugProject(ref);
      if (!project) {
        throw createServiceError(
          'BUG_PROJECT_NOT_FOUND',
          `附加 Bug 项目不存在：${ref}`,
          404
        );
      }
      return project;
    });
    const includeCommon = input.includeCommon !== false;
    const knowledgeBaseIds = [
      currentProject.id,
      ...(includeCommon ? [COMMON_BUG_KNOWLEDGE_BASE_ID] : []),
      ...additionalProjects.map((project) => project.id)
    ];
    const topK = input.topK || 5;

    // eligibility 在 Store/loadState 中已过滤；这里再次按列检查是应用层防御，确保未来调用
    // listBugCaseDocuments 的实现变化也不能把 candidate/rejected 带入候选截断。
    const bugCases = store.listBugCaseDocuments({ knowledgeBaseIds })
      .filter((document) => document.status === 'ready' && document.reviewStatus === 'confirmed')
      .map((document) => serializeBugCase(document, store))
      .filter((bugCase) => bugCaseMatchesFilters(bugCase, query.filters));
    if (!bugCases.length) {
      return {
        results: [],
        scope: {
          projectRefs: [projectRef, ...additionalRefs],
          knowledgeBaseIds,
          includesCommon: includeCommon
        },
        trace: { degradedChannels: [], ambiguous: false, evidenceGap: true }
      };
    }

    const candidateLimit = Math.max(topK * 8, 40);
    const exactMatches = matchExactBugSignatures(query, bugCases);
    const allowedDocumentIds = new Set(bugCases.map((bugCase) => bugCase.id));
    const channels = await knowledgeRetrieval.retrieveChunkCandidates(
      query.raw,
      candidateLimit,
      knowledgeBaseIds,
      signal
    );
    const exactDocumentIds = new Set(exactMatches.map((match) => match.documentId));
    const keywordMatches = channels.keyword.filter((match) =>
      allowedDocumentIds.has(match.documentId)
      && (exactDocumentIds.has(match.documentId) || hasLexicalAnchor(match, query.tokens))
    );
    const vectorMatches = selectMeaningfulVectorMatches(
      channels.vector.filter((match) => allowedDocumentIds.has(match.documentId)),
      exactMatches.length > 0 || keywordMatches.length > 0,
      query.tokens
    );
    const ranked = rankBugCases({
      bugCases,
      exactMatches,
      keywordMatches,
      vectorMatches,
      preferredProjectRef: projectRef,
      topK
    });
    const evidenceGap = ranked.results.length === 0;

    return {
      results: ranked.results,
      scope: {
        projectRefs: [projectRef, ...additionalRefs],
        knowledgeBaseIds,
        includesCommon: includeCommon
      },
      trace: {
        degradedChannels: channels.degradedChannels,
        ambiguous: ranked.trace.ambiguous,
        evidenceGap
      }
    };
  }

  return {
    listProjects,
    createProject,
    updateProject,
    listBugCases,
    getBugCase,
    createBugCase,
    updateBugCase,
    deleteBugCase,
    reviewBugCase,
    promoteBugCase,
    searchBugCases
  };
}
