import { useQueries, useQuery } from '@tanstack/react-query';
import {
  memoryApi,
  type MemoryListFilters,
  type MemoryStatus,
  type MemoryType
} from '@/services/memoryApi';

export const MEMORY_PAGE_SIZE = 50;

export type MemoryFilters = {
  status?: MemoryStatus;
  type?: MemoryType;
  query: string;
  page: number;
};

export function normalizeMemoryFilters(input: Partial<MemoryFilters>): MemoryFilters {
  const statuses: MemoryStatus[] = ['candidate', 'confirmed', 'corrected', 'rejected'];
  const types: MemoryType[] = ['profile', 'preference', 'fact', 'event', 'pitfall'];
  return {
    ...(input.status && statuses.includes(input.status) ? { status: input.status } : {}),
    ...(input.type && types.includes(input.type) ? { type: input.type } : {}),
    query: String(input.query || '').trim().slice(0, 500),
    page: Math.max(1, Math.floor(Number(input.page) || 1))
  };
}

function listRequest(filters: MemoryFilters): MemoryListFilters {
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    limit: MEMORY_PAGE_SIZE,
    offset: (filters.page - 1) * MEMORY_PAGE_SIZE
  };
}

export const memoryQueryKeys = {
  all: ['memory'] as const,
  lists: () => ['memory', 'list'] as const,
  list: (filters: MemoryFilters) => ['memory', 'list', filters] as const,
  detail: (id: string) => ['memory', 'detail', id] as const,
  counts: () => ['memory', 'counts'] as const
};

export function useMemoryList(filters: MemoryFilters) {
  return useQuery({
    queryKey: memoryQueryKeys.list(filters),
    queryFn: () => memoryApi.list(listRequest(filters)),
    placeholderData: (previous) => previous
  });
}

export function useMemoryDetail(memoryId?: string) {
  return useQuery({
    queryKey: memoryQueryKeys.detail(memoryId || ''),
    queryFn: () => memoryApi.get(memoryId || ''),
    enabled: Boolean(memoryId)
  });
}

export function useMemoryCounts() {
  const [total, candidates] = useQueries({
    queries: [
      {
        queryKey: [...memoryQueryKeys.counts(), 'total'] as const,
        queryFn: () => memoryApi.list({ limit: 1, offset: 0 }),
        staleTime: 30_000
      },
      {
        queryKey: [...memoryQueryKeys.counts(), 'candidate'] as const,
        queryFn: () => memoryApi.list({ status: 'candidate', limit: 1, offset: 0 }),
        staleTime: 30_000
      }
    ]
  });
  return {
    total: total.data?.total || 0,
    candidates: candidates.data?.total || 0,
    isLoading: total.isLoading || candidates.isLoading,
    isError: total.isError || candidates.isError
  };
}
