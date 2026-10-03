import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  memoryApi,
  type MemoryCreateInput,
  type MemoryPatch,
  type MemoryRecord
} from '@/services/memoryApi';
import { memoryQueryKeys } from './memoryQueries';

export function useMemoryMutations() {
  const queryClient = useQueryClient();

  function converge(memory: MemoryRecord) {
    queryClient.setQueryData(memoryQueryKeys.detail(memory.id), memory);
    void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.lists() });
    void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.counts() });
  }

  const create = useMutation({
    mutationFn: (input: MemoryCreateInput) => memoryApi.create(input),
    onSuccess: converge
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemoryPatch }) => memoryApi.update(id, patch),
    onSuccess: converge
  });

  const remove = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: memoryQueryKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: memoryQueryKeys.counts() });
    }
  });

  return { create, update, remove };
}
