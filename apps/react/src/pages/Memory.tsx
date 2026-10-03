import { useNavigate, useParams, useSearchParams } from 'react-router';
import { MemoryWorkspace } from '@/features/memory/MemoryWorkspace';
import { normalizeMemoryFilters, type MemoryFilters } from '@/features/memory/memoryQueries';
import type { MemoryStatus, MemoryType } from '@/services/memoryApi';

function paramsFor(filters: MemoryFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.query) params.set('q', filters.query);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

export function Memory() {
  const navigate = useNavigate();
  const { memoryId } = useParams();
  const [searchParams] = useSearchParams();
  const filters = normalizeMemoryFilters({
    status: searchParams.get('status') as MemoryStatus | undefined,
    type: searchParams.get('type') as MemoryType | undefined,
    query: searchParams.get('q') || '',
    page: Number(searchParams.get('page')) || 1
  });

  function url(nextFilters: MemoryFilters, nextMemoryId: string | undefined) {
    const path = nextMemoryId ? `/memory/${encodeURIComponent(nextMemoryId)}` : '/memory';
    const search = paramsFor(nextFilters);
    return `${path}${search ? `?${search}` : ''}`;
  }

  return (
    <MemoryWorkspace
      filters={filters}
      memoryId={memoryId}
      onFiltersChange={(next) => navigate(url(normalizeMemoryFilters(next), memoryId))}
      onOpenMemory={(id) => navigate(url(filters, id))}
      onCloseMemory={() => navigate(url(filters, undefined))}
      onCreated={(id) => navigate(`/memory/${encodeURIComponent(id)}`)}
      onOpenSourceConversation={(id) => navigate(`/chat/${encodeURIComponent(id)}`)}
    />
  );
}
