import { Router } from 'express';
import { encodeChatEvent } from '../chat/chat-events.js';

export function createChatRouter({ orchestrator }) {
  const router = Router();

  router.post('/api/chat/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => {
      if (!res.writableEnded) abort();
    });

    const emit = (event) => {
      if (res.writableEnded || res.destroyed) return false;
      res.write(encodeChatEvent(event));
      return true;
    };

    try {
      await orchestrator.run(req.body || {}, {
        signal: controller.signal,
        emit
      });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  });

  return router;
}
