import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { useKnowledgeBases } from '@/features/knowledge/knowledgeQueries';
import { isResearchNotFound } from '@/services/researchApi';
import type { ResearchSearchMode } from '@/services/researchApi';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';
import { PaneHeader } from '@/ui/PaneHeader';
import { ResearchDraftForm } from './ResearchDraftForm';
import { ResearchSessionPanel } from './ResearchSessionPanel';
import { ResearchTaskView } from './ResearchTaskView';
import {
  useResearchDraft,
  useResearchFollowUpDraft,
  type ResearchDraftSeedInput
} from './useResearchDraft';
import {
  canCancelResearchTask,
  canRetryResearchTask,
  countActiveResearchRuns,
  filterResearchSessions,
  formatResearchTime,
  groupResearchSessions,
  researchStatusLabel
} from './researchPresentation';
import {
  externalSearchFromSearchMode,
  resolveResearchSearchMode,
  type ResearchDraftSeed,
  type ResearchSubmitGates,
  type ResearchWorkspaceLocation
} from './researchViewState';
import {
  useResearchCapabilities,
  useResearchMutations,
  useResearchSession,
  useResearchTask,
  useResearchTasks,
  useSyncResearchTaskSnapshot
} from './researchQueries';

type ResearchWorkspaceProps = {
  location: ResearchWorkspaceLocation;
  draftSeed?: ResearchDraftSeed;
  onLocationChange: (
    next: ResearchWorkspaceLocation,
    options?: { replace?: boolean }
  ) => void;
};

const Workspace = styled.section`
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  h1 { margin: 0; font-size: 1.125rem; }
  p { margin: 0.25rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }
`;

const HeaderButton = styled.button`
  min-height: 2.5rem;
  padding: 0.55rem 0.9rem;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-control);
  color: white;
  background: var(--color-primary);
  font-size: 0.875rem;
  font-weight: 650;

  &:disabled { cursor: not-allowed; opacity: 0.55; }
`;

const Feedback = styled.p<{ $error?: boolean }>`
  margin: 0;
  padding: var(--space-2) var(--space-5);
  color: ${({ $error }) => ($error ? 'var(--color-danger)' : 'var(--color-text)')};
  background: ${({ $error }) => ($error ? 'var(--color-danger-surface)' : 'var(--color-background)')};
  font-size: 0.75rem;
`;

const MobileBack = styled.button`
  display: none;
  margin: var(--space-3) var(--space-4) 0;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-primary);
  background: var(--color-surface);
  font-size: 0.8125rem;

  @media (max-width: 48rem) { display: inline-flex; }
`;

const MainPanel = styled.main`
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
`;

const PaneActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
`;

const PaneActionButton = styled.button`
  min-height: 2.25rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  font-size: 0.78rem;

  &:disabled { cursor: not-allowed; opacity: 0.55; }
`;

const DangerActionButton = styled(PaneActionButton)`
  color: var(--color-danger);
  border-color: var(--color-danger-border);
`;

const ViewContainer = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
`;

const CenterState = styled.div`
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  min-height: 18rem;
  padding: var(--space-6);
  color: var(--color-text-muted);
  text-align: center;
  align-content: center;

  h2 { margin: 0; color: var(--color-text); font-size: 1.05rem; }
  p { margin: 0; font-size: 0.8125rem; overflow-wrap: anywhere; }
`;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ResearchWorkspace({ location, draftSeed, onLocationChange }: ResearchWorkspaceProps) {
  const capabilitiesQuery = useResearchCapabilities();
  const tasksQuery = useResearchTasks();
  const activeTaskId = 'taskId' in location ? location.taskId : undefined;
  const taskQuery = useResearchTask(activeTaskId);
  const sessionQuery = useResearchSession(activeTaskId);
  useSyncResearchTaskSnapshot(taskQuery.data);
  const { create, followUp, retry, cancel } = useResearchMutations();
  const knowledgeBasesQuery = useKnowledgeBases();

  const externalSearchReady = capabilitiesQuery.isSuccess;
  const externalSearchFailed = capabilitiesQuery.isError;
  const externalSearchAvailable = capabilitiesQuery.data?.publicPrimarySearch.available === true;
  // 门控要求当前请求成功且能力可用：后台刷新失败时即使缓存曾为 true 也停用外部提交。
  const externalSearchAllowed = externalSearchReady && externalSearchAvailable;
  const externalSearchLocked = capabilitiesQuery.isPending || capabilitiesQuery.isError || !externalSearchAvailable;

  const [reseedingDraft, setReseedingDraft] = useState<ResearchDraftSeedInput | undefined>(undefined);
  // Chat seed 只做一次 memoized 转换并直接作为 Hook 输入，避免每次渲染的新对象反复重置草稿。
  const chatSeedInput = useMemo<ResearchDraftSeedInput | undefined>(
    () => (draftSeed
      ? {
          question: draftSeed.question,
          knowledgeBaseIds: [...draftSeed.knowledgeBaseIds],
          externalSearch: false,
          fromChat: true
        }
      : undefined),
    [draftSeed]
  );
  const draft = useResearchDraft(chatSeedInput ?? reseedingDraft);
  const followUpDraft = useResearchFollowUpDraft();
  const [expandedSessionId, setExpandedSessionId] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const savedListScrollRef = useRef(0);

  const task = taskQuery.data;
  const taskSessionKey = task ? task.sessionId || task.id : '';
  const taskNotFound = taskQuery.isError && isResearchNotFound(taskQuery.error);

  useEffect(() => {
    setNotice('');
    setActionError('');
  }, [location]);

  useEffect(() => {
    if (taskSessionKey) setExpandedSessionId(taskSessionKey);
  }, [taskSessionKey]);

  useEffect(() => {
    if (location.view !== 'follow-up' || !task) return;
    followUpDraft.syncFromParent(task);
  }, [followUpDraft.syncFromParent, location.view, task]);

  useEffect(() => {
    if (location.view === 'list' && listScrollRef.current) {
      listScrollRef.current.scrollTop = savedListScrollRef.current;
    }
  }, [location.view]);

  // 资料库列表就绪后，移除草稿中已不存在或已失效的资料库 ID（含 seed 继承值）。
  // 资料库列表就绪后，移除草稿中已不存在或已失效的资料库 ID；
  // 依赖草稿字段本身，保证“资料库先到、seed（原研究/重新研究）后到”时同样被清理。
  const knowledgeBases = knowledgeBasesQuery.data || [];
  const pruneKnowledgeBaseIds = draft.pruneKnowledgeBaseIds;
  const pruneFollowUpKnowledgeBaseIds = followUpDraft.pruneKnowledgeBaseIds;
  useEffect(() => {
    if (!knowledgeBasesQuery.isSuccess) return;
    const knownIds = new Set(knowledgeBases.map((base) => base.id));
    pruneKnowledgeBaseIds(knownIds);
    pruneFollowUpKnowledgeBaseIds(knownIds);
  }, [knowledgeBases, knowledgeBasesQuery.isSuccess, pruneFollowUpKnowledgeBaseIds, pruneKnowledgeBaseIds, draft.knowledgeBaseIds, followUpDraft.values.knowledgeBaseIds]);

  const groupedSessions = useMemo(() => groupResearchSessions(tasksQuery.data || []), [tasksQuery.data]);
  const sessions = useMemo(() => filterResearchSessions(groupedSessions, location.status), [groupedSessions, location.status]);
  const activeRunCount = useMemo(() => countActiveResearchRuns(tasksQuery.data || []), [tasksQuery.data]);

  const sessionRuns = sessionQuery.data?.runs?.length ? sessionQuery.data.runs : (task ? [task] : []);
  const sessionBusy = sessionRuns.some((run) => run.status === 'queued' || run.status === 'running');

  const retrievableKnowledgeBaseIds = useMemo(
    () => new Set(knowledgeBases.filter((base) => base.publishedDocumentCount > 0).map((base) => base.id)),
    [knowledgeBases]
  );
  const submitGates = useCallback((selectedIds: string[]): ResearchSubmitGates => ({
    externalSearchAllowed,
    hasRetrievableInternalSource: selectedIds.some((id) => retrievableKnowledgeBaseIds.has(id))
  }), [externalSearchAllowed, retrievableKnowledgeBaseIds]);

  const draftSearchMode: ResearchSearchMode | null = resolveResearchSearchMode(draft, submitGates(draft.knowledgeBaseIds));
  const followUpSearchMode: ResearchSearchMode | null = resolveResearchSearchMode(followUpDraft.values, submitGates(followUpDraft.values.knowledgeBaseIds));

  const openList = useCallback(() => {
    onLocationChange({ view: 'list', status: location.status });
  }, [location.status, onLocationChange]);

  const handleSelectTask = useCallback((taskId: string) => {
    savedListScrollRef.current = listScrollRef.current?.scrollTop || 0;
    onLocationChange({ view: 'task', taskId, status: location.status });
  }, [location.status, onLocationChange]);

  const handleToggleSession = useCallback((sessionId: string) => {
    const isExpanding = expandedSessionId !== sessionId;
    setExpandedSessionId(isExpanding ? sessionId : '');
    if (!isExpanding) return;
    const session = groupedSessions.find((item) => item.id === sessionId);
    if (!session) return;
    const nextRun = session.runs.find((run) => run.id === activeTaskId) || session.latest;
    savedListScrollRef.current = listScrollRef.current?.scrollTop || 0;
    onLocationChange({ view: 'task', taskId: nextRun.id, status: location.status });
  }, [activeTaskId, expandedSessionId, groupedSessions, location.status, onLocationChange]);

  const openNewDraft = useCallback(() => {
    // 不重置草稿：同一次 Workspace 生命周期内的未提交草稿继续编辑；
    // 提交成功后的草稿已被 clear，进入即为空白新建。
    onLocationChange({ view: 'draft', status: location.status });
  }, [location.status, onLocationChange]);

  const reseedFromTask = useCallback(() => {
    if (!task) return;
    setReseedingDraft({
      question: task.question,
      knowledgeBaseIds: [...task.knowledgeBaseIds],
      externalSearch: externalSearchFromSearchMode(task.searchMode),
      sourceHint: '将基于原研究输入创建新的研究会话，原报告保持不变。'
    });
    onLocationChange({ view: 'draft', status: location.status });
  }, [location.status, onLocationChange, task]);

  const openFollowUp = useCallback(() => {
    if (task) onLocationChange({ view: 'follow-up', taskId: task.id, status: location.status });
  }, [location.status, onLocationChange, task]);

  async function submitDraft() {
    const snapshot = draft.beginSubmit(submitGates(draft.knowledgeBaseIds));
    if (!snapshot) return;
    try {
      const result = await create.mutateAsync(snapshot);
      draft.clear();
      setReseedingDraft(undefined);
      setNotice(result.notice);
      onLocationChange({ view: 'task', taskId: result.task.id, status: location.status }, { replace: true });
    } catch (error) {
      draft.setError(errorMessage(error, '创建研究任务失败'));
    } finally {
      draft.endSubmit();
    }
  }

  async function submitFollowUp() {
    if (followUpDraft.parentTaskId !== (task?.id || '')) return;
    const snapshot = followUpDraft.beginSubmit(submitGates(followUpDraft.values.knowledgeBaseIds));
    if (!snapshot) return;
    try {
      const result = await followUp.mutateAsync({ parentId: followUpDraft.parentTaskId, input: snapshot });
      followUpDraft.reset();
      setNotice(result.notice);
      onLocationChange({ view: 'task', taskId: result.task.id, status: location.status }, { replace: true });
    } catch (error) {
      followUpDraft.setError(errorMessage(error, '创建后续研究失败'));
    } finally {
      followUpDraft.endSubmit();
    }
  }

  async function cancelCurrentTask() {
    if (!task) return;
    setActionError('');
    try {
      await cancel.mutateAsync(task.id);
    } catch (error) {
      setActionError(errorMessage(error, '取消研究任务失败'));
    }
  }

  async function retryCurrentTask() {
    if (!task) return;
    setActionError('');
    try {
      await retry.mutateAsync(task.id);
    } catch (error) {
      setActionError(errorMessage(error, '重试研究任务失败'));
    }
  }

  const draftSourceHint = draft.fromChat
    ? '内容来自对话，可在提交前修改。'
    : reseedingDraft?.sourceHint;

  function renderDetail() {
    if (location.view === 'draft') {
      return (
        <ResearchDraftForm
          question={draft.question}
          onQuestionChange={draft.setQuestion}
          knowledgeBases={knowledgeBases}
          knowledgeBasesLoading={knowledgeBasesQuery.isPending}
          knowledgeBasesError={knowledgeBasesQuery.isError ? errorMessage(knowledgeBasesQuery.error, '加载资料库失败') : null}
          onRetryKnowledgeBases={() => void knowledgeBasesQuery.refetch()}
          selectedKnowledgeBaseIds={draft.knowledgeBaseIds}
          onToggleKnowledgeBase={draft.toggleKnowledgeBase}
          externalSearch={draft.externalSearch}
          onExternalSearchChange={draft.setExternalSearch}
          externalSearchLocked={externalSearchLocked}
          externalSearchReady={externalSearchReady}
          externalSearchFailed={externalSearchFailed}
          externalSearchAvailable={externalSearchAvailable}
          searchMode={draftSearchMode}
          submitting={draft.submitting}
          error={draft.error}
          submitLabel="创建研究任务"
          onSubmit={() => void submitDraft()}
        />
      );
    }

    if (location.view === 'follow-up') {
      if (taskNotFound) {
        return (
          <CenterState>
            <h2>研究任务不存在</h2>
            <p>无法基于不存在的任务继续研究。</p>
            <HeaderButton type="button" onClick={openList}>返回研究记录</HeaderButton>
          </CenterState>
        );
      }
      if (taskQuery.isError && !task) {
        return (
          <CenterState>
            <h2>暂时无法打开原研究</h2>
            <p>{errorMessage(taskQuery.error, '网络异常，请稍后重试。')}</p>
            <HeaderButton type="button" onClick={() => void taskQuery.refetch()}>重新加载</HeaderButton>
          </CenterState>
        );
      }
      if (!task) {
        return <CenterState><p>正在加载原研究…</p></CenterState>;
      }
      if (followUpDraft.parentTaskId !== task.id) {
        return <CenterState><p>正在准备继续研究…</p></CenterState>;
      }
      return (
        <ResearchDraftForm
          question={followUpDraft.values.question}
          onQuestionChange={followUpDraft.setQuestion}
          knowledgeBases={knowledgeBases}
          knowledgeBasesLoading={knowledgeBasesQuery.isPending}
          knowledgeBasesError={knowledgeBasesQuery.isError ? errorMessage(knowledgeBasesQuery.error, '加载资料库失败') : null}
          onRetryKnowledgeBases={() => void knowledgeBasesQuery.refetch()}
          selectedKnowledgeBaseIds={followUpDraft.values.knowledgeBaseIds}
          onToggleKnowledgeBase={followUpDraft.toggleKnowledgeBase}
          externalSearch={followUpDraft.values.externalSearch}
          onExternalSearchChange={followUpDraft.setExternalSearch}
          externalSearchLocked={externalSearchLocked}
          externalSearchReady={externalSearchReady}
          externalSearchFailed={externalSearchFailed}
          externalSearchAvailable={externalSearchAvailable}
          searchMode={followUpSearchMode}
          submitting={followUpDraft.submitting}
          error={followUpDraft.error}
          sourceHint={task.continuationContext
            ? `已继承上一轮的结论摘要与 ${task.continuationContext.citations?.length || 0} 条引用；它们仅用于聚焦本轮研究。`
            : '沿用原研究的资料范围与研究上下文。'}
          submitLabel="开始下一轮研究"
          onSubmit={() => void submitFollowUp()}
          busy={sessionBusy}
          busyHint="当前会话已有进行中的研究轮次，请等待完成后再继续。"
        />
      );
    }

    if (location.view === 'task') {
      if (taskNotFound) {
        return (
          <CenterState>
            <h2>研究任务不存在</h2>
            <p>任务可能已被移除，或当前无法从服务端读取。左侧列表仍可继续使用。</p>
            <HeaderButton type="button" onClick={openList}>返回研究记录</HeaderButton>
          </CenterState>
        );
      }
      if (taskQuery.isError && !task) {
        return (
          <CenterState>
            <h2>暂时无法打开研究任务</h2>
            <p>{errorMessage(taskQuery.error, '网络异常，请稍后重试。')}</p>
            <HeaderButton type="button" onClick={() => void taskQuery.refetch()}>重新加载</HeaderButton>
          </CenterState>
        );
      }
      if (!task) {
        return <CenterState><p>正在加载研究任务…</p></CenterState>;
      }
      return (
        <ResearchTaskView
          task={task}
          runs={sessionRuns}
          pollStale={taskQuery.isError}
          onSelectRun={handleSelectTask}
        />
      );
    }

    return (
      <CenterState>
        <h2>从一个问题开始</h2>
        <p>选择左侧研究会话继续阅读，或创建新的研究草稿。研究在后台执行，可以随时离开页面。</p>
        <HeaderButton type="button" onClick={openNewDraft}>新建研究</HeaderButton>
      </CenterState>
    );
  }

  function renderPaneHeader() {
    if (location.view === 'draft') {
      return (
        <PaneHeader
          title="新建研究"
          description={draftSourceHint || '研究问题、资料范围与外部检索都可在提交前修改。'}
        />
      );
    }
    if (location.view === 'follow-up') {
      return (
        <PaneHeader
          title="继续研究"
          description={task ? `第 ${task.turnIndex} 轮已完成 · 沿用其资料范围与研究上下文` : '正在加载原研究…'}
        />
      );
    }
    if (location.view === 'task') {
      if (!task) {
        return <PaneHeader title="研究详情" description={taskNotFound ? '研究任务不存在' : '正在加载研究任务…'} />;
      }
      return (
        <PaneHeader
          title="研究详情"
          description={`第 ${task.turnIndex} 轮 · ${researchStatusLabel(task.status)} · 更新于 ${formatResearchTime(task.updatedAt)}`}
          actions={(
            <PaneActions>
              {canCancelResearchTask(task) && (
                <DangerActionButton type="button" disabled={cancel.isPending} onClick={() => void cancelCurrentTask()}>
                  {cancel.isPending ? '取消中…' : '取消任务'}
                </DangerActionButton>
              )}
              {canRetryResearchTask(task) && (
                <PaneActionButton type="button" disabled={retry.isPending} onClick={() => void retryCurrentTask()}>
                  {retry.isPending ? '重新排队中…' : '重试'}
                </PaneActionButton>
              )}
              {task.status === 'completed' && (
                <PaneActionButton type="button" onClick={openFollowUp}>继续研究</PaneActionButton>
              )}
              {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                <PaneActionButton type="button" onClick={reseedFromTask}>重新研究</PaneActionButton>
              )}
            </PaneActions>
          )}
        />
      );
    }
    return <PaneHeader title="当前研究" description="从左侧选择研究会话，或创建新的研究草稿。" />;
  }

  return (
    <Workspace>
      <Header>
        <div>
          <h1>深度研究</h1>
          <p>以项目资料为背景，识别知识缺口并生成带引用的研究报告。</p>
        </div>
        <HeaderButton type="button" onClick={openNewDraft}>新建研究</HeaderButton>
      </Header>

      {notice ? <Feedback role="status">{notice}</Feedback> : null}
      {actionError ? <Feedback role="alert" $error>{actionError}</Feedback> : null}

      <MasterDetailLayout
        master={(
          <ResearchSessionPanel
            sessions={sessions}
            statusFilter={location.status}
            onStatusFilterChange={(status) => onLocationChange({ ...location, status })}
            activeTaskId={activeTaskId}
            expandedSessionId={expandedSessionId}
            onToggleSession={handleToggleSession}
            onSelectTask={handleSelectTask}
            loading={tasksQuery.isPending}
            totalCount={(tasksQuery.data || []).length}
            activeCount={activeRunCount}
            scrollRef={listScrollRef}
            error={tasksQuery.isError ? errorMessage(tasksQuery.error, '加载研究记录失败') : null}
            onRetry={() => void tasksQuery.refetch()}
          />
        )}
        detail={(
          <MainPanel aria-label="研究详情工作区">
            {location.view !== 'list' ? <MobileBack type="button" onClick={openList}>← 返回研究记录</MobileBack> : null}
            {renderPaneHeader()}
            <ViewContainer>{renderDetail()}</ViewContainer>
          </MainPanel>
        )}
        masterWidth="21rem"
        mobilePane={location.view === 'list' ? 'master' : 'detail'}
        masterLabel="研究记录"
        detailLabel="研究详情工作区"
      />
    </Workspace>
  );
}
