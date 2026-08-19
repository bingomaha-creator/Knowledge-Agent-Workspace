import { z } from 'zod';
import { getToolSpec } from '../tool-capabilities.js';
import { toErrorContent, toTextContent } from './tool-result.js';

const description = (name) => getToolSpec(name).description;

export function registerMemoryTools(server, { memoryService }) {
  server.registerTool(
    'retrieve_memory',
    {
      description: description('retrieve_memory'),
      inputSchema: z.object({
        query: z.string().min(1, 'query 不能为空').max(4000),
        topK: z.number().int().min(1).max(10).optional()
      })
    },
    async ({ query, topK = 4 }, extra) => {
      try {
        const memories = await memoryService.searchMemories(
          query,
          topK,
          { signal: extra?.signal }
        );
        return toTextContent({ memories, count: memories.length });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'create_memory',
    {
      description: description('create_memory'),
      inputSchema: z.object({
        type: z.enum(['profile', 'preference', 'fact', 'event', 'pitfall']),
        title: z.string().min(1).max(160),
        content: z.string().min(1).max(8000),
        details: z.record(z.string(), z.unknown()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().max(80)).max(8).optional()
      })
    },
    async (input, extra) => {
      try {
        return toTextContent(await memoryService.createMemory(input, extra?.signal));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'propose_memory',
    {
      description: description('propose_memory'),
      inputSchema: z.object({
        type: z.enum(['profile', 'preference', 'fact', 'event', 'pitfall']),
        title: z.string().min(1).max(160),
        content: z.string().min(1).max(8000),
        details: z.record(z.string(), z.unknown()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().max(80)).max(8).optional(),
        sourceConversationId: z.string().max(160).optional(),
        sourceMessageIds: z.array(z.string().max(160)).max(50).optional(),
        sourceExcerpt: z.string().max(12000).optional()
      })
    },
    async (input, extra) => {
      try {
        return toTextContent(await memoryService.proposeMemory(input, extra?.signal));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'list_memories',
    {
      description: description('list_memories'),
      inputSchema: z.object({
        ids: z.array(z.string().min(1).max(160)).max(100).optional(),
        statuses: z.array(z.enum(['candidate', 'confirmed', 'corrected', 'rejected'])).optional(),
        types: z.array(z.enum(['profile', 'preference', 'fact', 'event', 'pitfall'])).optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        offset: z.number().int().min(0).max(10_000_000).optional()
      })
    },
    async (filters) => toTextContent({
      memories: memoryService.listMemories(filters),
      total: memoryService.countMemories(filters)
    })
  );

  server.registerTool(
    'update_memory',
    {
      description: description('update_memory'),
      inputSchema: z.object({
        id: z.string().min(1),
        type: z.enum(['profile', 'preference', 'fact', 'event', 'pitfall']).optional(),
        title: z.string().min(1).max(160).optional(),
        content: z.string().min(1).max(8000).optional(),
        details: z.record(z.string(), z.unknown()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(['candidate', 'confirmed', 'corrected', 'rejected']).optional()
      })
    },
    async ({ id, ...patch }, extra) => {
      try {
        return toTextContent({
          memory: await memoryService.updateMemory(id, patch, extra?.signal)
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'delete_memory',
    {
      description: description('delete_memory'),
      inputSchema: z.object({ id: z.string().min(1, 'id 不能为空') })
    },
    async ({ id }) => {
      try {
        return toTextContent(memoryService.deleteMemory(id));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

}
