import type { ResearchArtifacts, ResearchTask } from './types';

export type ResearchPlanView = NonNullable<ResearchArtifacts['plan']>;
export type ResearchEvidencePackView = NonNullable<ResearchArtifacts['evidencePack']>;
export type ResearchDiagnosticsView = NonNullable<ResearchArtifacts['diagnostics']>;

export function plannerLabel(planner?: string) {
  if (planner === 'model') return '模型规划';
  if (planner === 'direct') return '直接检索';
  return '安全降级';
}
export function intentLabel(intent?: string) {
  return ({
    definition: '定义与边界',
    comparison: '对比判断',
    decision: '决策依据',
    risk: '风险限制',
    implementation: '落地方案',
    current_state: '当前状态',
    investigation: '核心研究'
  } as Record<string, string>)[intent || ''] || '研究角度';
}

export function sourceTypeLabel(value: string) {
  return ({
    project_knowledge: '项目资料',
    official_docs: '官方文档',
    official_repo: '官方仓库',
    paper: '论文',
    standard: '标准',
    government_document: '政府文件',
    public_web: '公开网页'
  } as Record<string, string>)[value] || value;
}

export function diagnosticReasonLabel(code?: string) {
  return ({
    model_unavailable: '未配置模型',
    request_timeout: '模型请求超时',
    upstream_error: '上游服务异常',
    invalid_plan: '规划结果未通过校验',
    empty_evidence_pack: '没有可写作证据',
    empty_output: '模型未返回正文',
    invalid_citations: '报告引用未通过校验'
  } as Record<string, string>)[code || ''] || '';
}

export function buildResearchRunViewModel(task: ResearchTask | null) {
  const artifacts = task?.artifacts;
  if (!task || !artifacts) {
    return { plan: null, evidencePack: null, diagnostics: null };
  }
  return {
    plan: artifacts.plan || null,
    evidencePack: artifacts.evidencePack || null,
    diagnostics: artifacts.diagnostics || {
      planning: artifacts.plan?.diagnostics || null,
      retrieval: artifacts.search?.diagnostics || [],
      reading: artifacts.reading || null,
      writing: artifacts.writer || null
    }
  };
}
