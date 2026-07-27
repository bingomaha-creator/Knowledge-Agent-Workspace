import { Router } from 'express';
import { getErrorPayload } from '../http-utils.js';

export function createSystemRouter({ presets = [], runStore, callMcpTool }) {
  const router = Router();

  router.get('/api/health', async (_req, res) => {
    try {
      const structured = await callMcpTool(
        'list_knowledge_documents',
        {},
        { requireSuccess: false, fallbackMessage: 'MCP 健康检查失败' }
      );
      res.json({
        ok: true,
        documents: Array.isArray(structured.documents) ? structured.documents.length : 0,
        mcp: true
      });
    } catch (error) {
      const payload = getErrorPayload(error, 'MCP 健康检查失败');
      res.status(payload.status).json({
        ok: false,
        code: payload.code,
        error: payload.message,
        details: payload.details
      });
    }
  });

  router.get('/api/presets', (_req, res) => {
    res.json({ presets });
  });

  router.get('/api/runs', (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string'
      ? req.query.conversationId.slice(0, 160)
      : undefined;
    res.json({ runs: runStore.listRuns({ conversationId, limit: req.query.limit }) });
  });

  router.get('/api/runs/:id', (req, res) => {
    const run = runStore.getRunWithSpans(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Agent run 不存在', code: 'RUN_NOT_FOUND' });
    }
    return res.json({ run });
  });

  return router;
}
