import { Router } from 'express';
import { getErrorPayload, queryList } from '../http-utils.js';

function sendRouteError(res, error, fallbackMessage) {
  const payload = getErrorPayload(error, fallbackMessage);
  res.status(payload.status).json({
    error: payload.message,
    code: payload.code,
    details: payload.details
  });
}

function bodyText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createMemoryRouter({ callMcpTool }) {
  const router = Router();

  router.post('/api/memories', async (req, res) => {
    try {
      const structured = await callMcpTool(
        'create_memory',
        {
          type: bodyText(req.body?.type),
          title: bodyText(req.body?.title),
          content: bodyText(req.body?.content),
          confidence: 1
        },
        { fallbackMessage: '创建长期记忆失败' }
      );
      res.status(201).json({ memory: structured.memory });
    } catch (error) {
      sendRouteError(res, error, '创建长期记忆失败');
    }
  });

  router.get('/api/memories', async (req, res) => {
    try {
      const requestedLimit = Number(req.query.limit);
      const requestedOffset = Number(req.query.offset);
      const statuses = queryList(req.query.status);
      const types = queryList(req.query.type);
      const structured = await callMcpTool(
        'list_memories',
        {
          ...(statuses ? { statuses } : {}),
          ...(types ? { types } : {}),
          ...(typeof req.query.query === 'string' && req.query.query.trim()
            ? { query: req.query.query.trim().slice(0, 500) }
            : {}),
          ...(Number.isInteger(requestedLimit) && requestedLimit > 0
            ? { limit: Math.min(requestedLimit, 5000) }
            : {}),
          ...(Number.isInteger(requestedOffset) && requestedOffset >= 0
            ? { offset: Math.min(requestedOffset, 10_000_000) }
            : {})
        },
        { fallbackMessage: '加载长期记忆失败' }
      );
      res.json({
        memories: structured.memories || [],
        total: Number(structured.total) || 0
      });
    } catch (error) {
      sendRouteError(res, error, '加载长期记忆失败');
    }
  });

  router.patch('/api/memories/:id', async (req, res) => {
    try {
      const allowed = ['type', 'title', 'content', 'details', 'confidence', 'status'];
      const patch = Object.fromEntries(
        allowed
          .filter((key) => Object.hasOwn(req.body || {}, key))
          .map((key) => [key, req.body[key]])
      );
      const structured = await callMcpTool(
        'update_memory',
        { id: req.params.id, ...patch },
        { fallbackMessage: '更新长期记忆失败' }
      );
      res.json({ memory: structured.memory });
    } catch (error) {
      sendRouteError(res, error, '更新长期记忆失败');
    }
  });

  router.delete('/api/memories/:id', async (req, res) => {
    try {
      await callMcpTool(
        'delete_memory',
        { id: req.params.id },
        { fallbackMessage: '删除长期记忆失败' }
      );
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, '删除长期记忆失败');
    }
  });

  return router;
}
