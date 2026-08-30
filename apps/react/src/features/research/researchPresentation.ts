import type {
  ResearchStage,
  ResearchTask,
  ResearchTaskStatus
} from '@/services/researchApi';
import type { ResearchStatusFilter } from './researchViewState';

export const RESEARCH_STAGES: ReadonlyArray<{ id: ResearchStage; label: string }> = [
  { id: 'planning', label: '拆解问题' },
  { id: 'retrieving', label: '检索资料' },
  { id: 'extracting', label: '提炼证据' },
  { id: 'outlining', label: '组织提纲' },
  { id: 'writing', label: '撰写报告' },
  { id: 'verifying', label: '核验引用' },
  { id: 'completed', label: '研究完成' }
];

export type ResearchSessionGroup = {
  id: string;
  runs: ResearchTask[];
  root: ResearchTask;
  latest: ResearchTask;
  active: boolean;
};

export function researchStatusLabel(status: ResearchTaskStatus) {
  return ({
    queued: '排队中',
    running: '研究中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消'
  })[status];
}

export function researchStageLabel(stage: string) {
  return RESEARCH_STAGES.find((item) => item.id === stage)?.label || stage;
}

export function researchQualityLabel(quality: string) {
  return ({
    pending: '评估中',
    sufficient: '证据充分',
    limited: '证据有限',
    insufficient: '无法形成充分结论'
  })[quality] || '评估中';
}

export function researchSearchModeLabel(mode: string) {
  return ({
    local: '仅项目资料',
    hybrid: '项目资料 + 外部检索',
    web: '仅外部检索'
  })[mode] || mode;
}

export function researchWebStatusLabel(status: string) {
  return ({
    not_requested: '未请求外部检索',
    pending: '等待外部检索',
    available: '外部检索完成',
    unavailable: '外部检索不可用，已降级本地',
    partial: '外部检索部分成功',
    error: '外部检索失败，已保留本地结果'
  })[status] || status;
}

export function researchSourceKindLabel(kind?: string) {
  return kind === 'web' ? '外部来源' : '内部资料';
}

export function plannerLabel(planner?: string) {
  if (planner === 'model') return '模型规划';
  if (planner === 'direct') return '直接检索';
  return '安全降级';
}

export function researchIntentLabel(intent?: string) {
  return ({
    definition: '定义与边界',
    comparison: '对比判断',
    decision: '决策依据',
    risk: '风险限制',
    implementation: '落地方案',
    current_state: '当前状态',
    investigation: '核心研究'
  })[intent || ''] || '研究角度';
}

export function researchSourceTypeLabel(value: string) {
  return ({
    project_knowledge: '项目资料',
    official_docs: '官方文档',
    official_repo: '官方仓库',
    paper: '论文',
    standard: '标准',
    government_document: '政府文件',
    public_web: '公开网页'
  })[value] || value;
}

export function researchDiagnosticReasonLabel(code?: string) {
  return ({
    model_unavailable: '未配置模型',
    request_timeout: '模型请求超时',
    upstream_error: '上游服务异常',
    invalid_plan: '规划结果未通过校验',
    empty_evidence_pack: '没有可写作证据',
    empty_output: '模型未返回正文',
    invalid_citations: '报告引用未通过校验'
  })[code || ''] || '';
}

export function clampResearchProgress(progress: number) {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0;
}

export function formatResearchTime(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

/** 研究外部引用只允许 HTTPS；其余 URL 一律作为纯文本展示。 */
export function safeResearchExternalUrl(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function isActiveResearchStatus(status: ResearchTaskStatus) {
  return status === 'queued' || status === 'running';
}

export function canCancelResearchTask(task: ResearchTask) {
  return isActiveResearchStatus(task.status);
}

/** 只有技术失败的 failed 才提供重试；cancelled 按 spec 走“重新研究”。 */
export function canRetryResearchTask(task: ResearchTask) {
  return task.status === 'failed';
}

export type ResearchStageState = 'done' | 'current' | 'failed' | 'pending';

export function researchStageState(task: ResearchTask, stage: ResearchStage): ResearchStageState {
  const currentIndex = RESEARCH_STAGES.findIndex((item) => item.id === (task.failedStage || task.stage));
  const stageIndex = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  if (task.status === 'completed' || (currentIndex >= 0 && stageIndex < currentIndex)) return 'done';
  if (stageIndex === currentIndex) return task.status === 'failed' ? 'failed' : 'current';
  return 'pending';
}

/** Session 分组：Run 按 turnIndex 升序；active-first，其余按最新更新时间倒序。 */
export function groupResearchSessions(tasks: ResearchTask[]): ResearchSessionGroup[] {
  const groups = new Map<string, ResearchTask[]>();
  for (const task of tasks) {
    const key = task.sessionId || task.id;
    groups.set(key, [...(groups.get(key) || []), task]);
  }
  return [...groups.entries()].map(([id, runs]) => {
    const orderedRuns = [...runs].sort((left, right) => left.turnIndex - right.turnIndex || left.createdAt - right.createdAt);
    return {
      id,
      runs: orderedRuns,
      root: orderedRuns.find((task) => !task.parentTaskId) || orderedRuns[0],
      latest: [...orderedRuns].sort((left, right) => right.updatedAt - left.updatedAt)[0],
      active: orderedRuns.some((task) => isActiveResearchStatus(task.status))
    };
  }).sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.latest.updatedAt - left.latest.updatedAt;
  });
}

export function filterResearchSessions(
  sessions: ResearchSessionGroup[],
  filter: ResearchStatusFilter
): ResearchSessionGroup[] {
  if (filter === 'all') return sessions;
  if (filter === 'active') return sessions.filter((session) => session.active);
  return sessions.filter((session) => session.runs.some((task) => task.status === filter));
}

export function countActiveResearchRuns(tasks: ResearchTask[]) {
  return tasks.filter((task) => isActiveResearchStatus(task.status)).length;
}
