import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  bugAgentApi,
  type BugCase,
  type BugCaseDraft,
  type BugCaseListFilters,
  type BugCasePatch,
  type BugEvidenceInput,
  type BugInvestigation,
  type BugInvestigationStatus,
  type BugSearchRequest
} from '@/services/bugAgentApi';

export const bugQueryKeys = {
  all: ['bugs'] as const,
  projects: () => ['bugs', 'projects'] as const,
  investigations: (projectRef: string) => ['bugs', 'investigations', projectRef] as const,
  investigation: (id: string) => ['bugs', 'investigation', id] as const,
  cases: (filters: BugCaseListFilters) => ['bugs', 'cases', filters] as const,
  case: (id: string) => ['bugs', 'case', id] as const,
  search: (request: BugSearchRequest) => ['bugs', 'search', request] as const
};

export function useBugProjects() {
  return useQuery({ queryKey: bugQueryKeys.projects(), queryFn: () => bugAgentApi.listProjects() });
}

export function useBugInvestigations(projectRef?: string) {
  return useQuery({
    queryKey: bugQueryKeys.investigations(projectRef || ''),
    queryFn: () => bugAgentApi.listInvestigations(projectRef || ''),
    enabled: Boolean(projectRef)
  });
}

export function useBugInvestigation(id?: string) {
  return useQuery({
    queryKey: bugQueryKeys.investigation(id || ''),
    queryFn: () => bugAgentApi.getInvestigation(id || ''),
    enabled: Boolean(id)
  });
}

export function useBugCases(filters: BugCaseListFilters) {
  const hasPending = (cases?: BugCase[]) => cases?.some((item) => item.status === 'queued' || item.status === 'processing');
  return useQuery({
    queryKey: bugQueryKeys.cases(filters),
    queryFn: () => bugAgentApi.listCases(filters),
    refetchInterval: (query) => hasPending(query.state.data) && query.state.dataUpdateCount < 40 ? 1_500 : false
  });
}

export function useBugCase(id?: string) {
  return useQuery({
    queryKey: bugQueryKeys.case(id || ''),
    queryFn: () => bugAgentApi.getCase(id || ''),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const item = query.state.data;
      return (item?.status === 'queued' || item?.status === 'processing') && query.state.dataUpdateCount < 40
        ? 1_500
        : false;
    }
  });
}

export function useBugSearch(request?: BugSearchRequest) {
  return useQuery({
    queryKey: bugQueryKeys.search(request || {} as BugSearchRequest),
    queryFn: () => bugAgentApi.searchCases(request as BugSearchRequest),
    enabled: Boolean(request?.query.trim()),
    placeholderData: (previous) => previous
  });
}

export function useBugMutations() {
  const queryClient = useQueryClient();

  function convergeInvestigation(item: BugInvestigation) {
    queryClient.setQueryData(bugQueryKeys.investigation(item.id), item);
    void queryClient.invalidateQueries({ queryKey: bugQueryKeys.investigations(item.projectRef) });
  }

  function convergeCase(item: BugCase) {
    queryClient.setQueryData(bugQueryKeys.case(item.id), item);
    void queryClient.invalidateQueries({ queryKey: ['bugs', 'cases'] });
    void queryClient.invalidateQueries({ queryKey: ['bugs', 'search'] });
    void queryClient.invalidateQueries({ queryKey: bugQueryKeys.projects() });
  }

  const createProject = useMutation({
    mutationFn: (input: { name: string; description?: string }) => bugAgentApi.createProject(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: bugQueryKeys.projects() })
  });
  const createInvestigation = useMutation({
    mutationFn: (input: { projectRef: string; title?: string; evidence: BugEvidenceInput }) => bugAgentApi.createInvestigation(input),
    onSuccess: convergeInvestigation
  });
  const appendEvidence = useMutation({
    mutationFn: ({ id, evidence }: { id: string; evidence: BugEvidenceInput }) => bugAgentApi.appendEvidence(id, evidence),
    onSuccess: convergeInvestigation
  });
  const analyzeInvestigation = useMutation({
    mutationFn: (id: string) => bugAgentApi.analyzeInvestigation(id),
    onSuccess: convergeInvestigation
  });
  const convertInvestigation = useMutation({
    mutationFn: (id: string) => bugAgentApi.convertInvestigation(id),
    onSuccess: convergeInvestigation
  });
  const closeInvestigation = useMutation({
    mutationFn: (id: string) => bugAgentApi.closeInvestigation(id),
    onSuccess: convergeInvestigation
  });
  const createCase = useMutation({ mutationFn: (input: BugCaseDraft) => bugAgentApi.createCase(input), onSuccess: convergeCase });
  const updateCase = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BugCasePatch }) => bugAgentApi.updateCase(id, patch),
    onSuccess: convergeCase
  });
  const reviewCase = useMutation({
    mutationFn: ({ id, reviewStatus, reviewReason }: { id: string; reviewStatus: 'confirmed' | 'rejected'; reviewReason: string }) =>
      bugAgentApi.reviewCase(id, { reviewStatus, reviewReason }),
    onSuccess: convergeCase
  });
  const promoteCase = useMutation({ mutationFn: (id: string) => bugAgentApi.promoteCase(id), onSuccess: convergeCase });
  const deleteCase = useMutation({
    mutationFn: (id: string) => bugAgentApi.deleteCase(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: bugQueryKeys.case(id) });
      void queryClient.invalidateQueries({ queryKey: ['bugs', 'cases'] });
      void queryClient.invalidateQueries({ queryKey: ['bugs', 'search'] });
      void queryClient.invalidateQueries({ queryKey: bugQueryKeys.projects() });
    }
  });

  return {
    createProject, createInvestigation, appendEvidence, analyzeInvestigation,
    convertInvestigation, closeInvestigation, createCase, updateCase,
    reviewCase, promoteCase, deleteCase
  };
}

export function investigationMatchesView(status: BugInvestigationStatus, view: 'active' | 'history') {
  return view === 'active' ? status === 'draft' : status !== 'draft';
}
