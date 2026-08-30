import { useCallback, useEffect, useRef } from 'react';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/services/sseClient';
import {
  researchApi,
  type ContinueResearchInput,
  type CreateResearchInput,
  type ResearchSessionSnapshot,
  type ResearchTask
} from '@/services/researchApi';

export const researchQueryKeys = {
  all: ['research'] as const,
  capabilities: () => ['research', 'capabilities'] as const,
  tasks: () => ['research', 'tasks'] as const,
  task: (id: string) => ['research', 'task', id] as const,
  /** 全部 Session 时间线查询的公共前缀（缓存可能以任意 run 的 taskId 为键）。 */
  sessions: () => ['research', 'session'] as const,
  session: (id: string) => ['research', 'session', id] as const
};

const TASK_POLL_INTERVAL_MS = 1250;
const LIST_ACTIVE_POLL_INTERVAL_MS = 4500;
const CAPABILITIES_STALE_TIME_MS = 5 * 60_000;

function isActive(task?: ResearchTask | null) {
  return Boolean(task && (task.status === 'queued' || task.status === 'running'));
}

/** 旧响应（如取消期间晚到的轮询）不得覆盖更新的权威快照。 */
function preferAuthoritativeTask(cached: ResearchTask | undefined, incoming: ResearchTask): ResearchTask {
  return cached && cached.updatedAt > incoming.updatedAt ? cached : incoming;
}

export function useResearchCapabilities() {
  return useQuery({
    queryKey: researchQueryKeys.capabilities(),
    queryFn: () => researchApi.getCapabilities(),
    staleTime: CAPABILITIES_STALE_TIME_MS,
    retry: false
  });
}

/** 列表缓存保存权威任务集合；筛选与 Session 分组不修改它。存在活动任务时低频轮询。 */
export function useResearchTasks() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: researchQueryKeys.tasks(),
    queryFn: async () => {
      const incoming = await researchApi.listTasks();
      const cached = queryClient.getQueryData<ResearchTask[]>(researchQueryKeys.tasks());
      if (!cached?.length) return incoming;
      const cachedById = new Map(cached.map((task) => [task.id, task]));
      return incoming.map((task) => {
        const local = cachedById.get(task.id);
        return local && local.updatedAt > task.updatedAt ? local : task;
      });
    },
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (
      query.state.data?.some((task) => task.status === 'queued' || task.status === 'running')
        ? LIST_ACTIVE_POLL_INTERVAL_MS
        : false
    )
  });
}

export function useResearchTask(taskId?: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: researchQueryKeys.task(taskId || ''),
    queryFn: async () => {
      const incoming = await researchApi.getTask(taskId as string);
      const cached = queryClient.getQueryData<ResearchTask>(researchQueryKeys.task(taskId as string));
      return preferAuthoritativeTask(cached, incoming);
    },
    enabled: Boolean(taskId),
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => !(error instanceof ApiError && error.status === 404) && failureCount < 2,
    refetchInterval: (query) => (isActive(query.state.data) ? TASK_POLL_INTERVAL_MS : false)
  });
}

export function useResearchSession(taskId?: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: researchQueryKeys.session(taskId || ''),
    queryFn: async () => {
      const incoming = await researchApi.getSession(taskId as string);
      const detailFor = (runId: string) => queryClient.getQueryData<ResearchTask>(researchQueryKeys.task(runId));
      const listRunFor = (runId: string) => queryClient.getQueryData<ResearchTask[]>(researchQueryKeys.tasks())?.find((item) => item.id === runId);
      const cached = queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session(taskId || ''));

      const runsById = new Map<string, ResearchTask>();
      const consider = (run: ResearchTask | undefined) => {
        if (!run) return;
        const existing = runsById.get(run.id);
        if (!existing || run.updatedAt > existing.updatedAt) runsById.set(run.id, run);
      };

      // 对同一 taskId，在响应、既有 Session 缓存、详情与列表缓存四个来源之间
      // 统一比较 updatedAt 并选择最新版本；不得因找到某个较新候选而提前返回，
      // 否则列表等更快来源会被详情的中间态掩盖。既有 Session 中响应未包含的
      // 轮次（如晚到期间新建的 follow-up）同样参与比较并保留。
      for (const run of cached?.runs || []) {
        consider(run);
        consider(detailFor(run.id));
        consider(listRunFor(run.id));
      }
      for (const run of incoming.runs) {
        consider(run);
        consider(detailFor(run.id));
        consider(listRunFor(run.id));
      }

      const runs = [...runsById.values()].sort((left, right) => left.turnIndex - right.turnIndex || left.createdAt - right.createdAt);
      return { sessionId: incoming.sessionId, runs };
    },
    enabled: Boolean(taskId),
    refetchOnWindowFocus: true,
    staleTime: 5_000
  });
}

function upsertTask(tasks: ResearchTask[] | undefined, task: ResearchTask): ResearchTask[] {
  if (!tasks) return [task];
  if (!tasks.some((item) => item.id === task.id)) return [task, ...tasks];
  // 与快照同步的其余路径同一原则：缓存中已存在更新的快照时不回退。
  return tasks.map((item) => {
    if (item.id !== task.id) return item;
    return item.updatedAt > task.updatedAt ? item : task;
  });
}

/**
 * 任务权威快照的唯一写入路径：同步 task 详情、列表与所有包含该任务（或同 Session）
 * 的 Session 时间线缓存。Session 缓存可能以任意 run 的 taskId 为键，因此按内容匹配
 * 更新，而不是假设缓存键等于 sessionId。
 */
function syncTaskIntoCaches(queryClient: QueryClient, task: ResearchTask) {
  queryClient.setQueryData(researchQueryKeys.task(task.id), task);
  queryClient.setQueryData<ResearchTask[]>(researchQueryKeys.tasks(), (old) => upsertTask(old, task));
  const sessionId = task.sessionId || task.id;
  queryClient.setQueriesData<ResearchSessionSnapshot>(
    { queryKey: researchQueryKeys.sessions() },
    (old) => (old && (old.sessionId === sessionId || old.runs.some((run) => run.id === task.id))
      ? { ...old, runs: upsertTask(old.runs, task) }
      : old)
  );
}

/** 详情轮询的新快照收敛到列表与 Session 缓存；指纹去重避免无意义的缓存写入。 */
export function useSyncResearchTaskSnapshot(task: ResearchTask | undefined) {
  const queryClient = useQueryClient();
  const syncedFingerprintRef = useRef('');

  useEffect(() => {
    if (!task) return;
    const fingerprint = `${task.id}:${task.status}:${task.updatedAt}`;
    if (syncedFingerprintRef.current === fingerprint) return;
    syncedFingerprintRef.current = fingerprint;
    syncTaskIntoCaches(queryClient, task);
  }, [queryClient, task]);
}

export function useResearchMutations() {
  const queryClient = useQueryClient();

  const refreshCollections = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: researchQueryKeys.tasks() });
  }, [queryClient]);

  const create = useMutation({
    mutationFn: async (input: CreateResearchInput) => {
      await queryClient.cancelQueries({ queryKey: researchQueryKeys.tasks() });
      return researchApi.createTask(input);
    },
    onSuccess: (result) => {
      syncTaskIntoCaches(queryClient, result.task);
      refreshCollections();
    }
  });

  const followUp = useMutation({
    mutationFn: async ({ parentId, input }: { parentId: string; input: ContinueResearchInput }) => {
      await queryClient.cancelQueries({ queryKey: researchQueryKeys.tasks() });
      return researchApi.continueTask(parentId, input);
    },
    onSuccess: (result) => {
      syncTaskIntoCaches(queryClient, result.task);
      refreshCollections();
    }
  });

  const retry = useMutation({
    mutationFn: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: researchQueryKeys.task(id) });
      return researchApi.retryTask(id);
    },
    onSuccess: (task) => {
      syncTaskIntoCaches(queryClient, task);
      refreshCollections();
    }
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: researchQueryKeys.task(id) });
      return researchApi.cancelTask(id);
    },
    onSuccess: (task) => {
      syncTaskIntoCaches(queryClient, task);
      refreshCollections();
    }
  });

  return { create, followUp, retry, cancel };
}
