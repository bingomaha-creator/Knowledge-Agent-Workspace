import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { knowledgeApi } from '@/services/knowledgeApi';
import {
  researchNewApi,
  type CreateResearchNewInput,
  type ResearchNewRun,
  type ResearchNewRunSummary
} from '@/services/researchNewApi';

export const researchNewQueryKeys = {
  all: ['research-new'] as const,
  capabilities: () => ['research-new', 'capabilities'] as const,
  runs: () => ['research-new', 'runs'] as const,
  run: (id: string) => ['research-new', 'run', id] as const,
  knowledgeBases: () => ['research-new', 'knowledge-bases'] as const
};

function isActive(run?: ResearchNewRunSummary) {
  return run?.status === 'queued' || run?.status === 'running';
}

function upsert(runs: ResearchNewRunSummary[] | undefined, run: ResearchNewRun) {
  if (!runs?.length) return [run];
  if (!runs.some((item) => item.id === run.id)) return [run, ...runs];
  return runs.map((item) => item.id === run.id && item.updatedAt <= run.updatedAt ? run : item);
}

export function useResearchNewCapabilities() {
  return useQuery({
    queryKey: researchNewQueryKeys.capabilities(),
    queryFn: () => researchNewApi.getCapabilities(),
    staleTime: 5 * 60_000,
    retry: false
  });
}

export function useResearchNewRuns() {
  return useQuery({
    queryKey: researchNewQueryKeys.runs(),
    queryFn: () => researchNewApi.listRuns(),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.some(isActive) ? 4_000 : false
  });
}

export function useResearchNewRun(id?: string) {
  return useQuery({
    queryKey: researchNewQueryKeys.run(id || ''),
    queryFn: () => researchNewApi.getRun(id as string),
    enabled: Boolean(id),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => isActive(query.state.data) ? 1_250 : false
  });
}

export function useResearchNewKnowledgeBases() {
  return useQuery({
    queryKey: researchNewQueryKeys.knowledgeBases(),
    queryFn: () => knowledgeApi.listBases(),
    staleTime: 30_000
  });
}

export function useResearchNewMutations() {
  const queryClient = useQueryClient();
  const sync = (run: ResearchNewRun) => {
    queryClient.setQueryData(researchNewQueryKeys.run(run.id), run);
    queryClient.setQueryData<ResearchNewRunSummary[]>(researchNewQueryKeys.runs(), (old) => upsert(old, run));
  };

  const create = useMutation({
    mutationFn: (input: CreateResearchNewInput) => researchNewApi.createRun(input),
    onSuccess: ({ run }) => sync(run)
  });
  const cancel = useMutation({
    mutationFn: (id: string) => researchNewApi.cancelRun(id),
    onSuccess: sync
  });

  return { create, cancel };
}
