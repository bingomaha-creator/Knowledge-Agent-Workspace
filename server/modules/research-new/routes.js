import { Router } from 'express';
import { adjacentSection, normalizeKnowledgeBaseIds } from './domain.js';
import { getErrorPayload } from '../../shared/http/utils.js';

function hasRetrievableDocument(knowledgeStore, knowledgeBaseIds) {
  const documents = knowledgeStore.listDocuments(knowledgeBaseIds);
  return documents.some((document) => document.status === 'ready'
    && document.publicationStatus === 'published');
}

export function createResearchNewRouter({
  store,
  worker,
  knowledgeStore,
  modelConfigured = false,
  webSearchConfigured = false,
  webSearchCapabilities = {},
  webReaderTransport = '',
  engine = 'node',
  knowledgeSearch,
  graphScope
}) {
  const router = Router();

  router.get('/api/research-new/capabilities', (_req, res) => {
    res.json({
      capabilities: {
        model: Boolean(modelConfigured),
        webSearch: Boolean(webSearchConfigured),
        webSearchProvider: {
          name: String(webSearchCapabilities.provider || 'unconfigured'),
          fullText: Boolean(webSearchCapabilities.fullText),
          domainFilter: Boolean(webSearchCapabilities.domainFilter),
          temporalFilter: Boolean(webSearchCapabilities.temporalFilter)
        },
        webReader: {
          configured: Boolean(webReaderTransport),
          transport: webReaderTransport || 'unconfigured'
        },
        modes: ['web', 'hybrid'],
        targetedReplan: true,
        engine
      }
    });
  });

  router.get('/api/research-new', (req, res) => {
    res.json({
      runs: store.list({
        limit: req.query.limit,
        offset: req.query.offset,
        status: typeof req.query.status === 'string' ? req.query.status : undefined
      })
    });
  });

  router.get('/api/research-new/:id', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({ error: '新版研究任务不存在', code: 'RESEARCH_NEW_NOT_FOUND' });
    return res.json({ run });
  });

  // Sidecar asks by Run ID; callers cannot widen its frozen Knowledge scope.
  router.post('/api/research-new/:id/retrieval', async (req, res, next) => {
    try {
      const run = store.get(req.params.id);
      if (!run || run.status !== 'running' || run.cancelRequested || run.mode !== 'hybrid'
          || run.diagnostics?.engine !== 'sidecar') {
        return res.status(409).json({ code: 'RESEARCH_RETRIEVAL_INACTIVE', error: '研究任务不允许检索' });
      }
      if (req.body?.contextSources !== undefined) {
        if (!Array.isArray(req.body.contextSources) || req.body.contextSources.length > 2) {
          return res.status(400).json({ code: 'RESEARCH_CONTEXT_INVALID', error: '上下文来源最多两项' });
        }
        if (run.diagnostics.retrievalBackend === 'graphrag') graphScope(run.knowledgeBaseIds);
        const documents = knowledgeStore.listDocuments(run.knowledgeBaseIds).filter((doc) =>
          doc.status === 'ready' && doc.publicationStatus === 'published' && doc.documentType === 'generic'
          && run.knowledgeBaseIds.includes(doc.knowledgeBaseId));
        const evidence = [];
        for (const anchor of req.body.contextSources) {
          if (!anchor || typeof anchor.documentId !== 'string' || typeof anchor.passage !== 'string'
              || anchor.passage.length > 3200 || typeof anchor.sourceId !== 'string') {
            return res.status(400).json({ code: 'RESEARCH_CONTEXT_INVALID', error: '原文定位参数无效' });
          }
          const document = documents.find((doc) => doc.id === anchor.documentId);
          const context = document && adjacentSection(document, anchor.passage);
          if (context && !evidence.some((item) => item.id === context.id)) {
            evidence.push({ ...context, anchorSourceId: anchor.sourceId });
          }
        }
        return res.json({ evidence });
      }
      if (run.diagnostics.retrievalBackend === 'graphrag') {
        return res.json({ graph: graphScope(run.knowledgeBaseIds) });
      }
      const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 4000) : '';
      if (!query) return res.status(400).json({ code: 'RESEARCH_QUERY_REQUIRED', error: '检索问题不能为空' });
      const result = await knowledgeSearch.searchEvidence({ query, knowledgeBaseIds: run.knowledgeBaseIds,
        limit: Math.max(1, Math.min(10, Number(req.body?.topK) || 6)) });
      return res.json(result);
    } catch (error) { next(error); }
  });

  router.post('/api/research-new', (req, res) => {
    try {
      if (!modelConfigured) {
        return res.status(503).json({
          error: '新版研究需要配置 Qwen 模型',
          code: 'RESEARCH_NEW_MODEL_UNAVAILABLE'
        });
      }
      const question = typeof req.body?.question === 'string'
        ? req.body.question.trim().slice(0, 4000)
        : '';
      if (!question) {
        return res.status(400).json({ error: '研究问题不能为空', code: 'RESEARCH_NEW_QUESTION_REQUIRED' });
      }
      const mode = req.body?.mode;
      if (!['web', 'hybrid'].includes(mode)) {
        return res.status(400).json({ error: '新版研究只支持 web 或 hybrid', code: 'RESEARCH_NEW_MODE_INVALID' });
      }
      const knowledgeBaseIds = normalizeKnowledgeBaseIds(req.body?.knowledgeBaseIds);
      if (mode === 'web' && knowledgeBaseIds.length) {
        return res.status(400).json({
          error: 'Web 模式不能携带知识库范围',
          code: 'RESEARCH_NEW_WEB_SCOPE_INVALID'
        });
      }
      if (mode === 'hybrid') {
        if (!knowledgeBaseIds.length) {
          return res.status(400).json({
            error: 'Hybrid 模式至少选择一个知识库',
            code: 'RESEARCH_NEW_KNOWLEDGE_REQUIRED'
          });
        }
        const missing = knowledgeBaseIds.find((id) => !knowledgeStore.getKnowledgeBase(id));
        if (missing) {
          return res.status(400).json({
            error: '研究范围包含不存在的知识库',
            code: 'KNOWLEDGE_BASE_NOT_FOUND',
            details: missing
          });
        }
        if (!hasRetrievableDocument(knowledgeStore, knowledgeBaseIds)) {
          return res.status(400).json({
            error: '所选知识库没有可检索的已发布文档',
            code: 'RESEARCH_NEW_KNOWLEDGE_EMPTY'
          });
        }
      }
      const retrievalBackend = req.body?.retrievalBackend || 'workspace';
      if (!['workspace', 'graphrag'].includes(retrievalBackend)) {
        return res.status(400).json({ code: 'RESEARCH_RETRIEVAL_INVALID', error: '不支持的资料检索方式' });
      }
      if (mode === 'hybrid' && engine === 'sidecar' && retrievalBackend === 'graphrag') graphScope(knowledgeBaseIds);
      const run = store.create({ question, mode, knowledgeBaseIds, engine, retrievalBackend });
      void worker.enqueue(run.id).catch((error) => {
        console.error(`[research-new] run ${run.id} could not start:`, error?.message || error);
      });
      return res.status(202).json({
        run,
        notice: engine === 'sidecar'
          ? '新版研究已进入 Sidecar 队列；资料研究严格限定所选知识库，当前不混合网页来源。'
          : webSearchConfigured
          ? '新版研究已进入队列。'
          : '未配置联网检索，任务可能以证据不足完成。'
      });
    } catch (error) {
      const payload = getErrorPayload(error, '创建新版研究任务失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  router.post('/api/research-new/:id/cancel', (req, res) => {
    try {
      const run = worker.cancel(req.params.id);
      if (!run) return res.status(404).json({ error: '新版研究任务不存在', code: 'RESEARCH_NEW_NOT_FOUND' });
      return res.json({ run });
    } catch (error) {
      const payload = getErrorPayload(error, '取消新版研究任务失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  return router;
}
