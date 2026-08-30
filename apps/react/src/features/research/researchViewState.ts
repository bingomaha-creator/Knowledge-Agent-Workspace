import type { ResearchSearchMode } from '@/services/researchApi';

export type ResearchStatusFilter = 'all' | 'active' | 'completed' | 'failed' | 'cancelled';

export type ResearchWorkspaceLocation =
  | { view: 'list'; status: ResearchStatusFilter }
  | { view: 'draft'; status: ResearchStatusFilter }
  | { view: 'task'; taskId: string; status: ResearchStatusFilter }
  | { view: 'follow-up'; taskId: string; status: ResearchStatusFilter };

/** Chat 通过 location.state 传入的草稿种子；只初始化草稿，不持久化来源 ID。 */
export type ResearchDraftSeed = {
  question: string;
  knowledgeBaseIds: string[];
  sourceSessionId?: string;
  sourceMessageId?: string;
};

/** 界面草稿字段：资料库范围 + 外部检索开关，提交时映射为 searchMode。 */
export type ResearchDraftValues = {
  question: string;
  knowledgeBaseIds: string[];
  externalSearch: boolean;
};

/**
 * searchMode 映射的合法性门控，由调用方按当前数据计算：
 * - externalSearchAllowed：capability 加载完成且 publicPrimarySearch.available。
 * - hasRetrievableInternalSource：已选资料库中至少一个存在可检索（已发布）文档。
 */
export type ResearchSubmitGates = {
  externalSearchAllowed: boolean;
  hasRetrievableInternalSource: boolean;
};

/**
 * 资料范围组合 -> searchMode：
 * 有可检索内部来源时 local/hybrid；否则仅在外部能力可用时允许 web；都不满足禁止提交。
 * externalSearch 开启但能力不可用时降级为 local（有效内部来源存在时），不提交 web/hybrid。
 */
export function resolveResearchSearchMode(
  values: Pick<ResearchDraftValues, 'knowledgeBaseIds' | 'externalSearch'>,
  gates: ResearchSubmitGates
): ResearchSearchMode | null {
  const externalRequested = values.externalSearch && gates.externalSearchAllowed;
  if (gates.hasRetrievableInternalSource) {
    return externalRequested ? 'hybrid' : 'local';
  }
  return externalRequested ? 'web' : null;
}

export function externalSearchFromSearchMode(mode: ResearchSearchMode): boolean {
  return mode !== 'local';
}
