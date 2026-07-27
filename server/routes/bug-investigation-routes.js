import { Router } from 'express';
import { getErrorPayload } from '../http-utils.js';

function sendRouteError(res, error, fallbackMessage) {
  const payload = getErrorPayload(error, fallbackMessage);
  res.status(payload.status).json({
    error: payload.message,
    code: payload.code,
    details: payload.details
  });
}

function pickEvidence(body = {}) {
  const metadata = body.metadata && typeof body.metadata === 'object'
    ? {
      ...(body.metadata.fileName !== undefined ? { fileName: body.metadata.fileName } : {}),
      ...(body.metadata.language !== undefined ? { language: body.metadata.language } : {}),
      ...(body.metadata.lineStart !== undefined ? { lineStart: body.metadata.lineStart } : {})
    }
    : undefined;
  return {
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(metadata ? { metadata } : {})
  };
}

/**
 * Investigation HTTP adapter 只映射 DTO。状态机、脱敏、分析与 Candidate 转换全部由
 * BugInvestigationService 持有，避免 route 成为第二套业务实现。
 */
export function createBugInvestigationRouter({ investigationService }) {
  if (!investigationService) {
    throw new TypeError('BugInvestigationRouter requires investigationService');
  }
  const router = Router();

  router.get('/api/bug-investigations', (req, res) => {
    try {
      res.json({
        investigations: investigationService.list({
          projectRef: req.query.projectRef ? String(req.query.projectRef) : '',
          status: req.query.status ? String(req.query.status) : '',
          limit: req.query.limit ? Number(req.query.limit) : undefined
        })
      });
    } catch (error) {
      sendRouteError(res, error, '加载 Bug 调查失败');
    }
  });

  router.get('/api/bug-investigations/:id', (req, res) => {
    try {
      res.json({ investigation: investigationService.get(req.params.id) });
    } catch (error) {
      sendRouteError(res, error, '加载 Bug 调查失败');
    }
  });

  router.post('/api/bug-investigations', async (req, res) => {
    try {
      const investigation = await investigationService.create({
        projectRef: req.body?.projectRef,
        title: req.body?.title,
        evidence: pickEvidence(req.body?.evidence)
      });
      res.status(201).json({ investigation });
    } catch (error) {
      sendRouteError(res, error, '创建 Bug 调查失败');
    }
  });

  router.post('/api/bug-investigations/:id/evidence', (req, res) => {
    try {
      const investigation = investigationService.appendEvidence(
        req.params.id,
        pickEvidence(req.body)
      );
      res.json({ investigation });
    } catch (error) {
      sendRouteError(res, error, '追加调查证据失败');
    }
  });

  router.post('/api/bug-investigations/:id/analyze', async (req, res) => {
    try {
      const investigation = await investigationService.analyze(req.params.id);
      res.json({ investigation });
    } catch (error) {
      sendRouteError(res, error, '分析 Bug 证据失败');
    }
  });

  router.post('/api/bug-investigations/:id/convert', async (req, res) => {
    try {
      const investigation = await investigationService.convertToCandidate(req.params.id);
      res.json({ investigation });
    } catch (error) {
      sendRouteError(res, error, '转为候选 BugCase 失败');
    }
  });

  router.post('/api/bug-investigations/:id/close', (req, res) => {
    try {
      res.json({ investigation: investigationService.close(req.params.id) });
    } catch (error) {
      sendRouteError(res, error, '关闭 Bug 调查失败');
    }
  });

  return router;
}
