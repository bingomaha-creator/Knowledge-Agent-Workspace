import { describe, expect, it } from 'vitest';
import type { ResearchWorkspaceLocation } from '@/features/research/researchViewState';
import { buildResearchUrl, parseResearchLocation } from './researchRoute';

describe('researchRoute', () => {
  it('parses the list view with default and explicit status filters', () => {
    expect(parseResearchLocation({}, new URLSearchParams())).toEqual({ view: 'list', status: 'all' });
    expect(parseResearchLocation({}, new URLSearchParams('status=active'))).toEqual({ view: 'list', status: 'active' });
    expect(parseResearchLocation({}, new URLSearchParams('status=completed'))).toEqual({ view: 'list', status: 'completed' });
  });

  it('parses /research/new as a draft, never as a task id', () => {
    expect(parseResearchLocation({ taskId: 'new' }, new URLSearchParams())).toEqual({ view: 'draft', status: 'all' });
    expect(parseResearchLocation({ taskId: 'new', action: 'follow-up' }, new URLSearchParams())).toEqual({ view: 'draft', status: 'all' });
  });

  it('parses task detail and follow-up views', () => {
    expect(parseResearchLocation({ taskId: 'research-1' }, new URLSearchParams('status=failed')))
      .toEqual({ view: 'task', taskId: 'research-1', status: 'failed' });
    expect(parseResearchLocation({ taskId: 'research-1', action: 'follow-up' }, new URLSearchParams('status=failed')))
      .toEqual({ view: 'follow-up', taskId: 'research-1', status: 'failed' });
  });

  it('normalizes invalid and explicit-all status values', () => {
    expect(parseResearchLocation({}, new URLSearchParams('status=bogus')).status).toBe('all');
    expect(parseResearchLocation({}, new URLSearchParams('status=all')).status).toBe('all');
  });

  it('builds canonical URLs without default params', () => {
    expect(buildResearchUrl({ view: 'list', status: 'all' })).toBe('/research');
    expect(buildResearchUrl({ view: 'list', status: 'active' })).toBe('/research?status=active');
    expect(buildResearchUrl({ view: 'draft', status: 'all' })).toBe('/research/new');
    expect(buildResearchUrl({ view: 'task', taskId: 'research-1', status: 'all' })).toBe('/research/research-1');
    expect(buildResearchUrl({ view: 'follow-up', taskId: 'research-1', status: 'completed' }))
      .toBe('/research/research-1/follow-up?status=completed');
  });

  it('round-trips every view and encodes special task ids', () => {
    const locations: ResearchWorkspaceLocation[] = [
      { view: 'list', status: 'failed' },
      { view: 'draft', status: 'all' },
      { view: 'task', taskId: 'case/1 2', status: 'cancelled' },
      { view: 'follow-up', taskId: 'case/1 2', status: 'active' }
    ];
    for (const location of locations) {
      const url = buildResearchUrl(location);
      const [path, query = ''] = url.split('?');
      const segments = path.split('/');
      const rawTaskId = segments[2];
      const params = {
        taskId: rawTaskId ? decodeURIComponent(rawTaskId) : undefined,
        action: segments[3]
      };
      const parsed = parseResearchLocation(params, new URLSearchParams(query));
      expect(parsed).toEqual(location);
      expect(buildResearchUrl(parsed)).toBe(url);
      expect(url.startsWith('/research')).toBe(true);
    }
  });
});
