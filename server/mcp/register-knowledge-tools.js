import { z } from 'zod';
import { getToolSpec } from '../tool-capabilities.js';
import { toErrorContent, toTextContent } from './tool-result.js';

const description = (name) => getToolSpec(name).description;

export function registerKnowledgeTools(server, { knowledgeService }) {
  server.registerTool(
    'retrieve_knowledge',
    {
      description: description('retrieve_knowledge'),
      inputSchema: z.object({
        query: z.string().min(1, 'query 不能为空').max(4000),
        topK: z.number().int().min(1).max(10).optional(),
        knowledgeBaseIds: z.array(z.string().min(1)).max(20).optional()
      })
    },
    async ({ query, topK = 4, knowledgeBaseIds }, extra) => {
      try {
        const { citations, trace } = await knowledgeService.searchKnowledge(
          query,
          topK,
          knowledgeBaseIds,
          extra?.signal
        );
        return toTextContent({ citations, count: citations.length, trace });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'list_knowledge_documents',
    {
      description: description('list_knowledge_documents'),
      inputSchema: z.object({
        knowledgeBaseIds: z.array(z.string().min(1)).max(20).optional(),
        statuses: z.array(z.enum(['queued', 'processing', 'ready', 'failed'])).optional()
      })
    },
    async ({ knowledgeBaseIds, statuses }) => toTextContent({
      documents: knowledgeService.listDocuments(knowledgeBaseIds, statuses)
    })
  );

  server.registerTool(
    'read_knowledge_document',
    {
      description: description('read_knowledge_document'),
      inputSchema: z.object({
        documentId: z.string().min(1, 'documentId 不能为空'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(12_000).optional(),
        knowledgeBaseIds: z.array(z.string().min(1)).max(20).optional()
      })
    },
    async ({ documentId, offset, limit, knowledgeBaseIds }) => {
      try {
        return toTextContent(knowledgeService.readPublishedDocument(documentId, {
          knowledgeBaseIds,
          offset,
          limit
        }));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'ingest_knowledge_documents',
    {
      description: description('ingest_knowledge_documents'),
      inputSchema: z.object({
        knowledgeBaseId: z.string().min(1).optional(),
        documents: z.array(z.object({
          name: z.string().min(1, 'name 不能为空'),
          content: z.string().min(1, 'content 不能为空')
        })).min(1, '至少导入一份文档')
      })
    },
    async ({ documents, knowledgeBaseId = 'kb-default' }) => {
      try {
        const inserted = await knowledgeService.ingestDocuments(documents, knowledgeBaseId);
        return toTextContent({
          documents: inserted,
          message: `已接收 ${inserted.length} 份知识草稿，正在后台处理。`
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'get_knowledge_document_preview',
    {
      description: description('get_knowledge_document_preview'),
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        knowledgeBaseId: z.string().min(1).optional()
      })
    },
    async ({ id, knowledgeBaseId }) => {
      try {
        return toTextContent(knowledgeService.getDocumentPreview(id, knowledgeBaseId));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'publish_knowledge_document',
    {
      description: description('publish_knowledge_document'),
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        knowledgeBaseId: z.string().min(1).optional()
      })
    },
    async ({ id, knowledgeBaseId }) => {
      try {
        return toTextContent({
          document: knowledgeService.publishDocument(id, knowledgeBaseId)
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'withdraw_knowledge_document',
    {
      description: description('withdraw_knowledge_document'),
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        knowledgeBaseId: z.string().min(1).optional()
      })
    },
    async ({ id, knowledgeBaseId }) => {
      try {
        return toTextContent({
          document: knowledgeService.withdrawDocument(id, knowledgeBaseId)
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'delete_knowledge_document',
    {
      description: description('delete_knowledge_document'),
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        knowledgeBaseId: z.string().min(1).optional()
      })
    },
    async ({ id, knowledgeBaseId }) => {
      try {
        return toTextContent(knowledgeService.deleteDocument(id, knowledgeBaseId));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'clear_knowledge_documents',
    {
      description: description('clear_knowledge_documents'),
      inputSchema: z.object({ knowledgeBaseId: z.string().min(1).optional() })
    },
    async ({ knowledgeBaseId }) =>
      toTextContent(knowledgeService.clearDocuments(knowledgeBaseId))
  );

  server.registerTool(
    'list_knowledge_bases',
    {
      description: description('list_knowledge_bases'),
      inputSchema: z.object({})
    },
    async () => toTextContent({
      knowledgeBases: knowledgeService.listKnowledgeBases()
    })
  );

  server.registerTool(
    'create_knowledge_base',
    {
      description: description('create_knowledge_base'),
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(300).optional()
      })
    },
    async (input) => {
      try {
        return toTextContent({
          knowledgeBase: knowledgeService.createKnowledgeBase(input)
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'update_knowledge_base',
    {
      description: description('update_knowledge_base'),
      inputSchema: z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(300).optional()
      })
    },
    async ({ id, ...input }) => {
      try {
        return toTextContent({
          knowledgeBase: knowledgeService.updateKnowledgeBase(id, input)
        });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'delete_knowledge_base',
    {
      description: description('delete_knowledge_base'),
      inputSchema: z.object({
        id: z.string().min(1),
        force: z.boolean().optional()
      })
    },
    async ({ id, force = false }) => {
      try {
        return toTextContent(knowledgeService.deleteKnowledgeBase(id, force));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );
}
