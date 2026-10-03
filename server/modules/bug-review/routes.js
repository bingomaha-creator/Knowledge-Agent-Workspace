import { Router } from 'express';

export function createBugReviewRouter({ client }) {
  const router = Router();
  const forward = (method, path) => async (req, res, next) => {
    try {
      const result = await client.request(method, path(req), method === 'POST' ? req.body : undefined);
      res.status(result.status).json(result.data);
    } catch (error) {
      if (error.status && error.code) res.status(error.status).json({ code: error.code, error: error.message });
      else next(error);
    }
  };
  for (const resource of ['health', 'reviews', 'library']) {
    router.get(`/api/bug-review/${resource}`, forward('GET', req => `/${resource}${resource === 'library' ? '?q=' + encodeURIComponent(String(req.query.q || '').slice(0, 1000)) : ''}`));
  }
  router.post('/api/bug-review/import', forward('POST', () => '/import'));
  for (const resource of ['reviews', 'library']) {
    router.get(`/api/bug-review/${resource}/:id`, forward('GET', req => `/${resource}/${encodeURIComponent(req.params.id)}`));
  }
  router.post('/api/bug-review/reviews/:id/:operation', (req, res, next) => {
    if (!['edit', 'approve', 'reject', 'publish', 'retry', 'refresh', 'regenerate', 'adopt', 'discard'].includes(req.params.operation)) {
      res.status(400).json({ code: 'INVALID_OPERATION', error: '不支持的复盘操作。' });
      return;
    }
    return forward('POST', r => `/reviews/${encodeURIComponent(r.params.id)}/${r.params.operation}`)(req, res, next);
  });
  return router;
}
