import type {
  ResearchStatusFilter,
  ResearchWorkspaceLocation
} from '@/features/research/researchViewState';

const STATUS_FILTERS: readonly ResearchStatusFilter[] = ['active', 'completed', 'failed', 'cancelled'];

type ResearchRouteParams = {
  taskId?: string;
  action?: string;
};

function parseStatusFilter(searchParams: URLSearchParams): ResearchStatusFilter {
  const value = searchParams.get('status');
  return value && STATUS_FILTERS.includes(value as ResearchStatusFilter)
    ? value as ResearchStatusFilter
    : 'all';
}

/**
 * URL 形状的唯一归属地：
 * /research            -> 列表
 * /research/new        -> 草稿（new 不是 taskId）
 * /research/:taskId    -> 任务详情
 * /research/:taskId/follow-up -> 继续研究草稿
 */
export function parseResearchLocation(params: ResearchRouteParams, searchParams: URLSearchParams): ResearchWorkspaceLocation {
  const status = parseStatusFilter(searchParams);
  const rawTaskId = params.taskId;

  if (!rawTaskId) return { view: 'list', status };
  if (rawTaskId === 'new') return { view: 'draft', status };
  if (params.action === 'follow-up') return { view: 'follow-up', taskId: rawTaskId, status };
  return { view: 'task', taskId: rawTaskId, status };
}

export function buildResearchUrl(location: ResearchWorkspaceLocation): string {
  const params = new URLSearchParams();
  if (location.status !== 'all') params.set('status', location.status);
  const query = params.toString();

  switch (location.view) {
    case 'list':
      return query ? `/research?${query}` : '/research';
    case 'draft':
      return query ? `/research/new?${query}` : '/research/new';
    case 'task':
      return `/research/${encodeURIComponent(location.taskId)}${query ? `?${query}` : ''}`;
    case 'follow-up':
      return `/research/${encodeURIComponent(location.taskId)}/follow-up${query ? `?${query}` : ''}`;
  }
}
