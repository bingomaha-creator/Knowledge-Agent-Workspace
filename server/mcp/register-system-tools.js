import { z } from 'zod';
import { getToolSpec } from '../tool-capabilities.js';
import { WEB_SEARCH_LIMITS } from '../web-search-provider.js';
import { toTextContent } from './tool-result.js';

const description = (name) => getToolSpec(name).description;

export function registerSystemTools(server, {
  webSearchProvider,
  now = () => new Date()
}) {
  server.registerTool(
    'get_current_time',
    {
      description: description('get_current_time'),
      inputSchema: z.object({})
    },
    async () => {
      const current = now();
      return toTextContent({
        iso: current.toISOString(),
        locale: current.toLocaleString('zh-CN', { hour12: false })
      });
    }
  );

  server.registerTool(
    'search_web',
    {
      description: description('search_web'),
      inputSchema: z.object({
        query: z.string().trim().min(1, 'query 不能为空').max(WEB_SEARCH_LIMITS.maxQueryLength),
        topK: z.number().int().min(1).max(WEB_SEARCH_LIMITS.maxResults).optional()
      })
    },
    async ({ query, topK = 5 }, extra) => toTextContent(
      await webSearchProvider.search(query, { topK, signal: extra?.signal })
    )
  );
}
