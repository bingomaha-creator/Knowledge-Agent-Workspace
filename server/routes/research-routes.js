import { Router } from 'express';
import { getErrorPayload } from '../http-utils.js';

export function createResearchRouter({
  researchStore,
  researchWorker,
  researchKnowledgeStore,
  enqueueResearch,
  normalizeKnowledgeBaseIds,
  webSearchConfigured = false
}) {
  const router = Router();

  router.get('/api/research', (req, res) => {
    const options = {
      limit: req.query.limit,
      offset: req.query.offset,
      status: typeof req.query.status === 'string' ? req.query.status : undefined
    };
    res.json({ tasks: researchStore.list(options) });
  });

  // 能力发现与任务列表分离：客户端只展示当前部署真正可用的创建选项，历史 web
  // 任务仍可读取，不需要为了 UI 简化而破坏既有持久化合同。
  router.get('/api/research/capabilities', (_req, res) => {
    res.json({
      capabilities: {
        localKnowledge: true,
        publicPrimarySearch: {
          available: Boolean(webSearchConfigured),
          role: 'supplemental'
        }
      }
    });
  });

  router.get('/api/research/:id/session', (req, res) => {
    const runs = researchStore.listSession(req.params.id);
    if (!runs) {
      return res.status(404).json({
        error: '研究任务不存在',
        code: 'RESEARCH_NOT_FOUND'
      });
    }
    return res.json({
      sessionId: runs[0]?.sessionId || req.params.id,
      runs
    });
  });

  router.get('/api/research/:id', (req, res) => {
    const task = researchStore.get(req.params.id);
    if (!task) {
      return res.status(404).json({
        error: '研究任务不存在',
        code: 'RESEARCH_NOT_FOUND'
      });
    }
    return res.json({ task });
  });

  router.post('/api/research', (req, res) => {
    try {
      const question = typeof req.body?.question === 'string'
        ? req.body.question.trim().slice(0, 4000)
        : '';
      if (!question) {
        return res.status(400).json({
          error: '研究问题不能为空',
          code: 'RESEARCH_QUESTION_REQUIRED'
        });
      }

      const searchMode = req.body?.searchMode || 'local';
      if (!['local', 'hybrid', 'web'].includes(searchMode)) {
        return res.status(400).json({
          error: '不支持的研究检索模式',
          code: 'RESEARCH_SEARCH_MODE_INVALID'
        });
      }
      const knowledgeBaseIds = normalizeKnowledgeBaseIds(req.body?.knowledgeBaseIds, []);
      const unknownKnowledgeBaseId = knowledgeBaseIds.find(
        (id) => !researchKnowledgeStore.getKnowledgeBase(id)
      );
      if (unknownKnowledgeBaseId) {
        return res.status(400).json({
          error: '研究范围包含不存在的知识库',
          code: 'KNOWLEDGE_BASE_NOT_FOUND',
          details: unknownKnowledgeBaseId
        });
      }

      const task = researchStore.create({ question, searchMode, knowledgeBaseIds });
      enqueueResearch(task.id);
      const notice = searchMode === 'local'
        ? '任务将仅使用当前选定的本地知识库。'
        : webSearchConfigured
          ? '已启用受控联网检索；失败时会保留本地研究结果。'
          : '未配置联网检索，任务将明确标记降级并仅使用本地知识库。';
      return res.status(202).json({ task, notice });
    } catch (error) {
      const payload = getErrorPayload(error, '创建研究任务失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  router.post('/api/research/:id/retry', (req, res) => {
    try {
      const task = researchStore.retry(req.params.id);
      if (!task) {
        return res.status(404).json({
          error: '研究任务不存在',
          code: 'RESEARCH_NOT_FOUND'
        });
      }
      enqueueResearch(task.id);
      return res.json({ task });
    } catch (error) {
      const payload = getErrorPayload(error, '重试研究任务失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  router.post('/api/research/:id/follow-ups', (req, res) => {
    try {
      const question = typeof req.body?.question === 'string'
        ? req.body.question.trim().slice(0, 4000)
        : '';
      if (!question) {
        return res.status(400).json({
          error: '继续研究的问题不能为空',
          code: 'RESEARCH_QUESTION_REQUIRED'
        });
      }
      const parent = researchStore.get(req.params.id);
      if (!parent) {
        return res.status(404).json({
          error: '研究任务不存在',
          code: 'RESEARCH_NOT_FOUND'
        });
      }
      const searchMode = req.body?.searchMode === undefined ? parent.searchMode : req.body.searchMode;
      if (!['local', 'hybrid', 'web'].includes(searchMode)) {
        return res.status(400).json({
          error: '不支持的研究检索模式',
          code: 'RESEARCH_SEARCH_MODE_INVALID'
        });
      }
      const knowledgeBaseIds = req.body?.knowledgeBaseIds === undefined
        ? parent.knowledgeBaseIds
        : normalizeKnowledgeBaseIds(req.body.knowledgeBaseIds, []);
      const unknownKnowledgeBaseId = knowledgeBaseIds.find(
        (id) => !researchKnowledgeStore.getKnowledgeBase(id)
      );
      if (unknownKnowledgeBaseId) {
        return res.status(400).json({
          error: '研究范围包含不存在的知识库',
          code: 'KNOWLEDGE_BASE_NOT_FOUND',
          details: unknownKnowledgeBaseId
        });
      }
      const task = researchStore.continueSession(req.params.id, {
        question,
        searchMode,
        knowledgeBaseIds
      });
      enqueueResearch(task.id);
      return res.status(202).json({
        task,
        notice: `已创建第 ${task.turnIndex} 轮研究，并沿用上一轮的研究上下文。`
      });
    } catch (error) {
      const payload = getErrorPayload(error, '创建后续研究失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  router.post('/api/research/:id/cancel', (req, res) => {
    try {
      const task = researchWorker.cancel(req.params.id);
      if (!task) {
        return res.status(404).json({
          error: '研究任务不存在',
          code: 'RESEARCH_NOT_FOUND'
        });
      }
      return res.json({ task });
    } catch (error) {
      const payload = getErrorPayload(error, '取消研究任务失败');
      return res.status(payload.status).json({
        error: payload.message,
        code: payload.code,
        details: payload.details
      });
    }
  });

  return router;
}
