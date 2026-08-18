import { Router } from 'express';
import { encodeChatEvent } from '../chat/chat-events.js';
import { getErrorPayload } from '../http-utils.js';

function sendError(res, error, fallbackMessage) {
  const payload = getErrorPayload(error, fallbackMessage);
  res.status(payload.status).json({
    error: payload.message,
    code: payload.code,
    details: payload.details
  });
}

function attachStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });

  return {
    signal: controller.signal,
    emit(event) {
      if (res.writableEnded || res.destroyed) return false;
      res.write(encodeChatEvent(event));
      return true;
    }
  };
}

export function createChatRouter({ orchestrator, chatService }) {
  const router = Router();

  router.get('/api/chat/sessions', (req, res) => {
    try {
      res.json({ sessions: chatService.listSessions({ limit: req.query.limit }) });
    } catch (error) {
      sendError(res, error, '无法读取会话列表');
    }
  });

  router.get('/api/chat/sessions/:sessionId', (req, res) => {
    try {
      const session = chatService.getSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({
          error: '会话不存在',
          code: 'CHAT_SESSION_NOT_FOUND',
          details: ''
        });
      }
      return res.json({ session });
    } catch (error) {
      return sendError(res, error, '无法读取会话');
    }
  });

  router.get('/api/chat/sessions/:sessionId/messages', (req, res) => {
    try {
      return res.json(chatService.listMessages(req.params.sessionId, {
        before: req.query.before,
        limit: req.query.limit
      }));
    } catch (error) {
      return sendError(res, error, '无法读取会话消息');
    }
  });

  router.patch('/api/chat/sessions/:sessionId', (req, res) => {
    try {
      return res.json({
        session: chatService.updateSession(req.params.sessionId, req.body || {})
      });
    } catch (error) {
      return sendError(res, error, '无法更新会话');
    }
  });

  router.delete('/api/chat/sessions/:sessionId', (req, res) => {
    try {
      const deleted = chatService.deleteSession(req.params.sessionId);
      if (!deleted) {
        return res.status(404).json({
          error: '会话不存在',
          code: 'CHAT_SESSION_NOT_FOUND',
          details: ''
        });
      }
      return res.json({ deleted: true });
    } catch (error) {
      return sendError(res, error, '无法删除会话');
    }
  });

  router.get('/api/chat/messages/:messageId', (req, res) => {
    try {
      const message = chatService.getMessage(req.params.messageId);
      if (!message) {
        return res.status(404).json({
          error: '消息不存在',
          code: 'CHAT_MESSAGE_NOT_FOUND',
          details: ''
        });
      }
      return res.json({ message });
    } catch (error) {
      return sendError(res, error, '无法读取消息');
    }
  });

  router.post('/api/chat/messages/stream', async (req, res) => {
    let reply;
    try {
      // 校验、幂等检查和首轮写入必须先于 SSE Header，失败才能返回标准 JSON。
      reply = chatService.openReply(req.body || {});
    } catch (error) {
      return sendError(res, error, '无法发送消息');
    }

    const stream = attachStream(req, res);
    stream.emit({ type: 'accepted', data: reply.accepted });

    try {
      await reply.run(stream);
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  });

  // Vue Chat 迁移完成前保留旧入口；它仍由旧客户端提交完整 messages。
  router.post('/api/chat/stream', async (req, res) => {
    const stream = attachStream(req, res);

    try {
      await orchestrator.run(req.body || {}, {
        signal: stream.signal,
        emit: stream.emit
      });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  });

  return router;
}
