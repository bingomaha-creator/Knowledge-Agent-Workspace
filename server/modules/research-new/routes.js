import { Router } from 'express';
import { normalizeKnowledgeBaseIds } from './domain.js';
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
  engine = 'node'
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
      const run = store.create({ question, mode, knowledgeBaseIds, engine });
      void worker.enqueue(run.id).catch((error) => {
        console.error(`[research-new] run ${run.id} could not start:`, error?.message || error);
      });
      return res.status(202).json({
        run,
        notice: engine === 'sidecar'
          ? '新版研究已进入 Sidecar 队列；Hybrid 当前使用 Sidecar 预建图谱，不会动态同步所选知识库。'
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
