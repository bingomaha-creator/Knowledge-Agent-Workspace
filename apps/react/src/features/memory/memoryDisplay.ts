import type { MemoryRecord, MemoryStatus, MemoryType } from '@/services/memoryApi';
import type { MemoryFilters } from './memoryQueries';

export const memoryTypes: MemoryType[] = ['profile', 'preference', 'fact', 'event', 'pitfall'];
export const memoryStatuses: MemoryStatus[] = ['candidate', 'confirmed', 'corrected', 'rejected'];

export function memoryTypeLabel(type: MemoryType) {
  return { profile: '画像', preference: '偏好', fact: '事实', event: '事件', pitfall: '踩坑' }[type];
}

export function memoryTypeDescription(type: MemoryType) {
  return {
    profile: '稳定背景、职责或技术方向。',
    preference: '希望助手长期遵循的表达或协作偏好。',
    fact: '项目、业务或环境中相对稳定的事实。',
    event: '带有时间属性的经历、计划或节点。',
    pitfall: '已验证且未来可能复用的技术踩坑。'
  }[type];
}

export function memoryStatusLabel(status: MemoryStatus) {
  return { candidate: '待审查', confirmed: '已确认', corrected: '已纠正', rejected: '已拒绝' }[status];
}

export function matchesMemoryFilters(memory: MemoryRecord, filters: MemoryFilters) {
  if (filters.status && memory.status !== filters.status) return false;
  if (filters.type && memory.type !== filters.type) return false;
  if (!filters.query) return true;
  const query = filters.query.toLocaleLowerCase();
  return [memory.title, memory.content, memory.sourceExcerpt]
    .some((value) => String(value || '').toLocaleLowerCase().includes(query));
}
