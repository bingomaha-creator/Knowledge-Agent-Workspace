import { describe, expect, it } from 'vitest';
import { memoryQueryKeys, normalizeMemoryFilters } from './memoryQueries';

describe('memory query rules', () => {
  it('normalizes addressable filters into a stable list key', () => {
    const filters = normalizeMemoryFilters({
      status: 'candidate', type: 'fact', query: '  React  ', page: 2.9
    });
    expect(filters).toEqual({ status: 'candidate', type: 'fact', query: 'React', page: 2 });
    expect(memoryQueryKeys.list(filters)).toEqual(['memory', 'list', filters]);
  });

  it('drops invalid filters and repairs invalid pages', () => {
    expect(normalizeMemoryFilters({
      status: 'unknown' as never,
      type: 'unknown' as never,
      query: '',
      page: -4
    })).toEqual({ query: '', page: 1 });
  });
});
