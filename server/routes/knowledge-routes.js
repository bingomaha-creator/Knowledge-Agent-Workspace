import { Router } from 'express';
import multer from 'multer';
import { createAppError, getErrorPayload } from '../http-utils.js';

function createKnowledgeUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 4 * 1024 * 1024,
      files: 10
    },
    fileFilter: (_req, file, callback) => {
      if (!/\.(md|markdown|txt|json)$/i.test(file.originalname || '')) {
        callback(createAppError(
          'UNSUPPORTED_FILE',
          '不支持的知识文件类型',
          '仅支持 `.md`、`.markdown`、`.txt`、`.json` 文件。',
          400
        ));
        return;
      }
      callback(null, true);
    }
  });
}

function sendRouteError(res, error, fallbackMessage) {
  const payload = getErrorPayload(error, fallbackMessage);
  res.status(payload.status).json({
    error: payload.message,
    code: payload.code,
    details: payload.details
  });
}

export function createKnowledgeRouter({ callMcpTool }) {
  const router = Router();
  const upload = createKnowledgeUpload();

  router.get('/api/knowledge-bases', async (_req, res) => {
    try {
      const structured = await callMcpTool(
        'list_knowledge_bases',
        {},
        { fallbackMessage: '加载知识库工作区失败' }
      );
      res.json({ knowledgeBases: structured.knowledgeBases || [] });
    } catch (error) {
      sendRouteError(res, error, '加载知识库工作区失败');
    }
  });

  router.post('/api/knowledge-bases', async (req, res) => {
    try {
      const structured = await callMcpTool(
        'create_knowledge_base',
        {
          name: req.body?.name,
          description: req.body?.description || ''
        },
        { fallbackMessage: '创建知识库失败' }
      );
      res.status(201).json({ knowledgeBase: structured.knowledgeBase });
    } catch (error) {
      sendRouteError(res, error, '创建知识库失败');
    }
  });

  router.patch('/api/knowledge-bases/:id', async (req, res) => {
    try {
      const structured = await callMcpTool(
        'update_knowledge_base',
        {
          id: req.params.id,
          ...(typeof req.body?.name === 'string' ? { name: req.body.name } : {}),
          ...(typeof req.body?.description === 'string'
            ? { description: req.body.description }
            : {})
        },
        { fallbackMessage: '更新知识库失败' }
      );
      res.json({ knowledgeBase: structured.knowledgeBase });
    } catch (error) {
      sendRouteError(res, error, '更新知识库失败');
    }
  });

  router.delete('/api/knowledge-bases/:id', async (req, res) => {
    try {
      await callMcpTool(
        'delete_knowledge_base',
        { id: req.params.id, force: req.query.force === 'true' },
        { fallbackMessage: '删除知识库失败' }
      );
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, '删除知识库失败');
    }
  });

  router.get('/api/knowledge', async (req, res) => {
    try {
      const structured = await callMcpTool(
        'list_knowledge_documents',
        req.query.knowledgeBaseId
          ? { knowledgeBaseIds: [String(req.query.knowledgeBaseId)] }
          : {},
        { requireSuccess: false, fallbackMessage: '加载知识库失败' }
      );
      res.json({ documents: structured.documents || [] });
    } catch (error) {
      sendRouteError(res, error, '加载知识库失败');
    }
  });

  router.post('/api/knowledge/upload', upload.array('files'), async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const structured = await callMcpTool(
        'ingest_knowledge_documents',
        {
          knowledgeBaseId:
            typeof req.body?.knowledgeBaseId === 'string' && req.body.knowledgeBaseId.trim()
              ? req.body.knowledgeBaseId.trim()
              : 'kb-default',
          documents: files.map((file) => ({
            name: file.originalname,
            content: file.buffer.toString('utf-8')
          }))
        },
        { fallbackMessage: '知识库导入失败' }
      );
      res.json({
        documents: structured.documents || [],
        message: structured.message || '上传成功'
      });
    } catch (error) {
      sendRouteError(res, error, '知识库导入失败');
    }
  });

  router.get('/api/knowledge/:id/preview', async (req, res) => {
    try {
      const structured = await callMcpTool(
        'get_knowledge_document_preview',
        {
          id: req.params.id,
          ...(req.query.knowledgeBaseId
            ? { knowledgeBaseId: String(req.query.knowledgeBaseId) }
            : {})
        },
        { fallbackMessage: '加载文档预览失败' }
      );
      res.json({ document: structured.document, preview: structured.preview });
    } catch (error) {
      sendRouteError(res, error, '加载文档预览失败');
    }
  });

  for (const [action, toolName, fallbackMessage] of [
    ['publish', 'publish_knowledge_document', '发布知识文档失败'],
    ['withdraw', 'withdraw_knowledge_document', '撤回知识文档失败']
  ]) {
    router.post(`/api/knowledge/:id/${action}`, async (req, res) => {
      try {
        const structured = await callMcpTool(
          toolName,
          {
            id: req.params.id,
            ...(req.query.knowledgeBaseId
              ? { knowledgeBaseId: String(req.query.knowledgeBaseId) }
              : {})
          },
          { fallbackMessage }
        );
        res.json({ document: structured.document });
      } catch (error) {
        sendRouteError(res, error, fallbackMessage);
      }
    });
  }

  router.delete('/api/knowledge/:id', async (req, res) => {
    try {
      await callMcpTool(
        'delete_knowledge_document',
        {
          id: req.params.id,
          ...(req.query.knowledgeBaseId
            ? { knowledgeBaseId: String(req.query.knowledgeBaseId) }
            : {})
        },
        { fallbackMessage: '删除失败' }
      );
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, '删除失败');
    }
  });

  router.delete('/api/knowledge', async (req, res) => {
    try {
      await callMcpTool(
        'clear_knowledge_documents',
        req.query.knowledgeBaseId
          ? { knowledgeBaseId: String(req.query.knowledgeBaseId) }
          : {},
        { fallbackMessage: '清空失败' }
      );
      res.json({ ok: true });
    } catch (error) {
      sendRouteError(res, error, '清空失败');
    }
  });

  return router;
}
