import { Router } from 'express';
import { getErrorPayload, queryList } from '../http-utils.js';

const BUG_CONTENT_FIELDS = [
  'title',
  'symptom',
  'errorSignatures',
  'reproductionSteps',
  'context',
  'resolutionType',
  'rootCause',
  'fix',
  'workaroundRisks',
  'applicability',
  'verification',
  'tags',
  'sourceRefs'
];

function pickDefined(source, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => source?.[field] !== undefined)
      .map((field) => [field, source[field]])
  );
}

function sendRouteError(res, error, fallbackMessage) {
  const payload = getErrorPayload(error, fallbackMessage);
  res.status(payload.status).json({
    error: payload.message,
    code: payload.code,
    details: payload.details
  });
}

/**
 * Bug UI 的 HTTP adapter。字段 allowlist 是第一道不可信输入边界，真正的字段限制与审核状态机
 * 仍由 MCP schema + BugKnowledgeService 重复保证；route 本身不打开 SQLite 或实现领域规则。
 */
export function createBugKnowledgeRouter({ callMcpTool }) {
  const router = Router();

  router.get('/api/bug-projects', async (_req, res) => {
    try {
      const result = await callMcpTool('list_bug_projects');
      res.json({ projects: result.projects || [] });
    } catch (error) {
      sendRouteError(res, error, '加载 Bug 项目失败');
    }
  });

  router.post('/api/bug-projects', async (req, res) => {
    try {
      const result = await callMcpTool(
        'create_bug_project',
        pickDefined(req.body, ['name', 'description'])
      );
      res.status(201).json({ project: result.project });
    } catch (error) {
      sendRouteError(res, error, '创建 Bug 项目失败');
    }
  });

  router.patch('/api/bug-projects/:projectRef', async (req, res) => {
    try {
      const result = await callMcpTool('update_bug_project', {
        projectRef: req.params.projectRef,
        ...pickDefined(req.body, ['name', 'description'])
      });
      res.json({ project: result.project });
    } catch (error) {
      sendRouteError(res, error, '更新 Bug 项目失败');
    }
  });

  router.get('/api/bug-cases', async (req, res) => {
    try {
      const args = {
        ...(req.query.sourceProjectRef
          ? { sourceProjectRef: String(req.query.sourceProjectRef) }
          : {}),
        ...(req.query.scope ? { scope: String(req.query.scope) } : {}),
        ...(queryList(req.query.reviewStatus)
          ? { reviewStatuses: queryList(req.query.reviewStatus) }
          : {}),
        ...(queryList(req.query.status) ? { statuses: queryList(req.query.status) } : {}),
        ...(queryList(req.query.knowledgeBaseId)
          ? { knowledgeBaseIds: queryList(req.query.knowledgeBaseId) }
          : {})
      };
      const result = await callMcpTool('list_bug_cases', args);
      res.json({ bugCases: result.bugCases || [] });
    } catch (error) {
      sendRouteError(res, error, '加载 BugCase 失败');
    }
  });

  router.post('/api/bug-cases', async (req, res) => {
    try {
      const result = await callMcpTool('create_bug_case', {
        ...pickDefined(req.body, ['sourceProjectRef']),
        ...pickDefined(req.body, BUG_CONTENT_FIELDS)
      });
      res.status(201).json({ bugCase: result.bugCase });
    } catch (error) {
      sendRouteError(res, error, '创建 BugCase 失败');
    }
  });

  router.post('/api/bug-cases/search', async (req, res) => {
    try {
      const filters = pickDefined(req.body?.filters, [
        'language',
        'framework',
        'versions',
        'tags'
      ]);
      const result = await callMcpTool('search_bug_cases', {
        ...pickDefined(req.body, [
          'query',
          'projectRef',
          'includeCommon',
          'additionalProjectRefs',
          'topK'
        ]),
        ...(Object.keys(filters).length ? { filters } : {})
      });
      res.json({
        results: result.results || [],
        scope: result.scope,
        trace: result.trace
      });
    } catch (error) {
      sendRouteError(res, error, '检索 BugCase 失败');
    }
  });

  router.get('/api/bug-cases/:id', async (req, res) => {
    try {
      const result = await callMcpTool('get_bug_case', { id: req.params.id });
      res.json({ bugCase: result.bugCase });
    } catch (error) {
      sendRouteError(res, error, '加载 BugCase 失败');
    }
  });

  router.patch('/api/bug-cases/:id', async (req, res) => {
    try {
      const result = await callMcpTool('update_bug_case', {
        id: req.params.id,
        ...pickDefined(req.body, BUG_CONTENT_FIELDS)
      });
      res.json({ bugCase: result.bugCase });
    } catch (error) {
      sendRouteError(res, error, '更新 BugCase 失败');
    }
  });

  router.delete('/api/bug-cases/:id', async (req, res) => {
    try {
      await callMcpTool('delete_bug_case', { id: req.params.id });
      res.json({ ok: true, id: req.params.id });
    } catch (error) {
      sendRouteError(res, error, '删除 BugCase 失败');
    }
  });

  router.post('/api/bug-cases/:id/review', async (req, res) => {
    try {
      const result = await callMcpTool('review_bug_case', {
        id: req.params.id,
        ...pickDefined(req.body, ['reviewStatus', 'reviewReason'])
      });
      res.json({ bugCase: result.bugCase });
    } catch (error) {
      sendRouteError(res, error, '审核 BugCase 失败');
    }
  });

  router.post('/api/bug-cases/:id/promote', async (req, res) => {
    try {
      const result = await callMcpTool('promote_bug_case', { id: req.params.id });
      res.json({ bugCase: result.bugCase });
    } catch (error) {
      sendRouteError(res, error, '提升公共 BugCase 失败');
    }
  });

  return router;
}
