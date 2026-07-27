import { z } from 'zod';
import { getToolSpec } from '../tool-capabilities.js';
import { toErrorContent, toTextContent } from './tool-result.js';

const description = (name) => getToolSpec(name).description;

const bugContextSchema = z.object({
  language: z.string().trim().max(500).optional(),
  framework: z.string().trim().max(500).optional(),
  versions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  module: z.string().trim().max(500).optional(),
  environment: z.string().trim().max(500).optional()
}).strict();

const bugContentShape = {
  title: z.string().trim().min(1).max(160),
  symptom: z.string().trim().min(1).max(8_000),
  errorSignatures: z.array(z.string().trim().min(1).max(2_000)).max(30).optional(),
  reproductionSteps: z.array(z.string().trim().min(1).max(2_000)).max(30).optional(),
  context: bugContextSchema.optional(),
  resolutionType: z.enum(['root_cause_fix', 'verified_workaround']).optional(),
  // null 是 verified_workaround 的有意语义：明确表示“根因未知”，不是漏传字段。
  rootCause: z.string().max(12_000).nullable().optional(),
  fix: z.string().max(12_000).optional(),
  workaroundRisks: z.array(z.string().trim().min(1).max(2_000)).max(30).optional(),
  applicability: z.array(z.string().trim().min(1).max(2_000)).max(30).optional(),
  verification: z.string().max(12_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  sourceRefs: z.array(z.string().trim().min(1).max(2_000)).max(30).optional()
};

const createBugCaseSchema = z.object({
  sourceProjectRef: z.string().trim().min(1).max(200),
  ...bugContentShape
}).strict();

const updateBugCaseSchema = z.object({
  id: z.string().trim().min(1),
  ...Object.fromEntries(
    Object.entries(bugContentShape).map(([name, schema]) => [name, schema.optional()])
  )
}).strict().refine(
  (input) => Object.keys(input).some((key) => key !== 'id'),
  { message: '至少提供一个要修改的 BugCase 字段' }
);

function withErrorMapping(handler) {
  return async (...args) => {
    try {
      return toTextContent(await handler(...args));
    } catch (error) {
      return toErrorContent(error);
    }
  };
}

/**
 * MCP registrar 只拥有不可信 DTO 的 schema 和返回包装；审核转换、身份生成与持久化规则
 * 全部委托给 BugKnowledgeService，避免 HTTP/MCP 两条入口产生不同业务行为。
 */
export function registerBugTools(server, { bugKnowledgeService }) {
  server.registerTool(
    'list_bug_projects',
    {
      description: description('list_bug_projects'),
      inputSchema: z.object({}).strict()
    },
    withErrorMapping(() => ({ projects: bugKnowledgeService.listProjects() }))
  );

  server.registerTool(
    'create_bug_project',
    {
      description: description('create_bug_project'),
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).optional()
      }).strict()
    },
    withErrorMapping((input) => ({
      project: bugKnowledgeService.createProject(input)
    }))
  );

  server.registerTool(
    'update_bug_project',
    {
      description: description('update_bug_project'),
      inputSchema: z.object({
        projectRef: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).optional()
      }).strict().refine(
        (input) => input.name !== undefined || input.description !== undefined,
        { message: '至少提供 name 或 description' }
      )
    },
    withErrorMapping(({ projectRef, ...input }) => ({
      project: bugKnowledgeService.updateProject(projectRef, input)
    }))
  );

  server.registerTool(
    'list_bug_cases',
    {
      description: description('list_bug_cases'),
      inputSchema: z.object({
        sourceProjectRef: z.string().trim().min(1).optional(),
        scope: z.enum(['project', 'common']).optional(),
        reviewStatuses: z.array(z.enum(['candidate', 'confirmed', 'rejected'])).optional(),
        statuses: z.array(z.enum(['queued', 'processing', 'ready', 'failed'])).optional(),
        knowledgeBaseIds: z.array(z.string().trim().min(1)).max(30).optional()
      }).strict()
    },
    withErrorMapping((filters) => ({
      bugCases: bugKnowledgeService.listBugCases(filters)
    }))
  );

  server.registerTool(
    'create_bug_case',
    {
      description: description('create_bug_case'),
      inputSchema: createBugCaseSchema
    },
    withErrorMapping((input) => ({
      bugCase: bugKnowledgeService.createBugCase(input)
    }))
  );

  server.registerTool(
    'get_bug_case',
    {
      description: description('get_bug_case'),
      inputSchema: z.object({ id: z.string().trim().min(1) }).strict()
    },
    withErrorMapping(({ id }) => ({ bugCase: bugKnowledgeService.getBugCase(id) }))
  );

  server.registerTool(
    'update_bug_case',
    {
      description: description('update_bug_case'),
      inputSchema: updateBugCaseSchema
    },
    withErrorMapping(({ id, ...patch }) => ({
      bugCase: bugKnowledgeService.updateBugCase(id, patch)
    }))
  );

  server.registerTool(
    'delete_bug_case',
    {
      description: description('delete_bug_case'),
      inputSchema: z.object({ id: z.string().trim().min(1) }).strict()
    },
    withErrorMapping(({ id }) => bugKnowledgeService.deleteBugCase(id))
  );

  server.registerTool(
    'review_bug_case',
    {
      description: description('review_bug_case'),
      inputSchema: z.object({
        id: z.string().trim().min(1),
        reviewStatus: z.enum(['confirmed', 'rejected']),
        reviewReason: z.string().trim().min(1).max(2_000)
      }).strict()
    },
    withErrorMapping(({ id, ...review }) => ({
      bugCase: bugKnowledgeService.reviewBugCase(id, review)
    }))
  );

  server.registerTool(
    'promote_bug_case',
    {
      description: description('promote_bug_case'),
      inputSchema: z.object({ id: z.string().trim().min(1) }).strict()
    },
    withErrorMapping(({ id }) => ({
      bugCase: bugKnowledgeService.promoteBugCase(id)
    }))
  );

  server.registerTool(
    'search_bug_cases',
    {
      description: description('search_bug_cases'),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(8_000),
        projectRef: z.string().trim().min(1).max(200),
        includeCommon: z.boolean().optional(),
        additionalProjectRefs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
        filters: z.object({
          language: z.string().trim().max(500).optional(),
          framework: z.string().trim().max(500).optional(),
          versions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
          tags: z.array(z.string().trim().min(1).max(100)).max(20).optional()
        }).strict().optional(),
        topK: z.number().int().min(1).max(20).optional()
      }).strict()
    },
    withErrorMapping((input, extra) =>
      bugKnowledgeService.searchBugCases(input, extra?.signal)
    )
  );
}
