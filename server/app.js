import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { getErrorPayload } from './shared/http/utils.js';

/**
 * 创建一个尚未 listen 的 Express 应用。
 *
 * 调用方负责构造所有 feature router 和聊天 router；这个 factory 只拥有协议中间件顺序，
 * 因而 import 本模块不会打开 SQLite、启动 Worker/MCP 或监听端口。
 */
export function createApp({
  systemRouter,
  researchNewRouter,
  bugReviewRouter,
  knowledgeRouter,
  memoryRouter,
  chatRouter,
  frontendDir
} = {}) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/research', (_req, res) => {
    res.status(410).json({ code: 'RESEARCH_RETIRED', error: '旧版深度研究已退役，请使用当前深度研究入口。' });
  });

  app.use(['/api/bug-projects', '/api/bug-cases', '/api/bug-investigations'], (_req, res) => {
    res.status(410).json({ code: 'BUG_RETIRED', error: '旧版 Bug 调查与案例接口已退役，请使用 Bug 复盘入口。' });
  });

  for (const router of [
    systemRouter,
    researchNewRouter,
    bugReviewRouter,
    knowledgeRouter,
    memoryRouter,
    chatRouter
  ]) {
    if (router) app.use(router);
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof multer.MulterError) {
      const limitMessages = {
        LIMIT_FILE_SIZE: '单个知识文件不能超过 4MB',
        LIMIT_FILE_COUNT: '一次最多上传 10 个知识文件',
        LIMIT_UNEXPECTED_FILE: '上传字段或文件数量不符合要求'
      };
      res.status(400).json({
        error: limitMessages[error.code] || '知识文件上传失败',
        code: error.code,
        details: error.message
      });
      return;
    }

    const payload = getErrorPayload(error, '服务异常');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  });

  if (frontendDir) {
    app.use(express.static(frontendDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(frontendDir, 'index.html'));
    });
  }

  return app;
}
