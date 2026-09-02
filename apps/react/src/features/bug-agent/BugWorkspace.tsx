import { useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import type { BugEvidenceInput } from '@/services/bugAgentApi';
import { Button } from '@/ui/Button';
import { Empty } from '@/ui/Empty';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { Select } from '@/ui/Select';
import { WorkspaceControlBar } from '@/ui/WorkspaceControlBar';
import { BugCaseWorkspace } from './BugCaseWorkspace';
import { InvestigationWorkspace } from './InvestigationWorkspace';
import { useBugMutations, useBugProjects } from './bugQueries';
import {
  defaultBugCaseFilters,
  type BugSection,
  type BugWorkspaceLocation
} from './bugViewState';

export type BugInvestigationSeed = {
  title?: string;
  evidence: BugEvidenceInput;
  sourceMessageId?: string;
  sourceSessionId?: string;
};

type BugWorkspaceProps = {
  location: BugWorkspaceLocation;
  seed?: BugInvestigationSeed;
  onLocationChange: (next: BugWorkspaceLocation, options?: { replace?: boolean }) => void;
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

const ProjectField = styled.label`
  display: flex;
  flex: 0 1 26rem;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);
  margin-right: auto;

  @media (max-width: 48rem) {
    flex-basis: 100%;
  }
`;

const ProjectSelect = styled(Select)`
  flex: 1;
  min-width: 0;
  width: auto;
`;

const ProjectLabel = styled.span`
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;

const ProjectForm = styled.form`
  display: flex;
  flex: 0 1 30rem;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);
  margin-right: auto;

  input {
    min-width: 0;
    flex: 1;
  }

  @media (max-width: 48rem) {
    flex-basis: 100%;
  }
`;

const SectionTabs = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  overflow-x: auto;

  button {
    min-height: 2.5rem;
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    white-space: nowrap;
    color: var(--color-text-muted);
    background: var(--color-surface);
    font-size: 0.875rem;
  }
  button[aria-selected="true"] {
    border-color: var(--color-primary-border);
    color: var(--color-primary);
    background: var(--color-primary-surface);
    font-weight: 700;
  }

  @media (max-width: 48rem) {
    margin-right: auto;
  }
`;

const Content = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`;

const EmptyStateWrap = styled.div`
  display: grid;
  flex: 1;
  align-content: center;
  justify-items: center;
  gap: var(--space-4);
  min-width: 0;
  padding: var(--space-6);
  text-align: center;
`;

const EmptyHint = styled.p`
  margin: 0;
  color: var(--color-text-subtle);
  font-size: 0.8125rem;
`;
const Alert = styled.p`
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-control);
  color: var(--color-danger);
  background: var(--color-danger-surface);
`;

export function BugWorkspace({ location, seed, onLocationChange }: BugWorkspaceProps) {
  const projectsQuery = useBugProjects();
  const mutations = useBugMutations();
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectError, setProjectError] = useState('');
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const projectSelectRef = useRef<HTMLButtonElement>(null);
  const emptyCtaRef = useRef<HTMLButtonElement>(null);
  const wasCreatingRef = useRef(false);
  const projects = projectsQuery.data || [];
  const selectedProjectRef = projects.some((project) => project.projectRef === location.projectRef)
    ? location.projectRef
    : projects[0]?.projectRef;

  useEffect(() => {
    if (!projects.length || selectedProjectRef === location.projectRef) return;
    onLocationChange({
      ...location,
      projectRef: selectedProjectRef,
      recordId: undefined,
      creating: location.creating && !location.projectRef
    }, { replace: true });
  }, [location, onLocationChange, projects.length, selectedProjectRef]);

  // 创建表单关闭（取消或创建成功）后，把焦点还给仍然可聚焦的触发入口；
  // 无项目时选择器处于禁用态不可聚焦，回退到空态 CTA。
  useEffect(() => {
    if (wasCreatingRef.current && !creatingProject) {
      const select = projectSelectRef.current;
      const target = select && !select.disabled ? select : (emptyCtaRef.current ?? select);
      target?.focus();
    }
    wasCreatingRef.current = creatingProject;
  }, [creatingProject]);

  function sectionLocation(nextSection: BugSection): BugWorkspaceLocation {
    return {
      ...location,
      section: nextSection,
      projectRef: selectedProjectRef,
      recordId: undefined,
      creating: false,
      investigationView: 'active',
      caseFilters: defaultBugCaseFilters()
    };
  }

  function openProjectForm() {
    if (creatingProject) {
      projectNameInputRef.current?.focus();
      return;
    }
    setCreatingProject(true);
  }

  function cancelProjectForm() {
    setProjectError('');
    setCreatingProject(false);
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) return;
    setProjectError('');
    try {
      const project = await mutations.createProject.mutateAsync({ name: projectName.trim() });
      setProjectName('');
      setCreatingProject(false);
      onLocationChange({
        ...location,
        projectRef: project.projectRef,
        recordId: undefined,
        creating: false,
        investigationView: 'active',
        caseFilters: defaultBugCaseFilters()
      });
    } catch (caught) {
      setProjectError(caught instanceof Error ? caught.message : '创建 Bug 项目失败');
    }
  }

  return (
    <Workspace>
      <FeatureHeader
        title="Bug Agent"
        description="用证据推进调查，把验证过的问题沉淀为可检索案例。"
        actions={(
          <Button
            variant="primary"
            type="button"
            disabled={!selectedProjectRef}
            onClick={() => onLocationChange({ ...sectionLocation('investigations'), creating: true })}
          >新建调查</Button>
        )}
      />
      <WorkspaceControlBar>
        {creatingProject ? (
          <ProjectForm onSubmit={createProject}>
            <input
              ref={projectNameInputRef}
              autoFocus
              aria-label="新项目名称"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="项目名称"
            />
            <Button variant="primary" type="submit" disabled={!projectName.trim() || mutations.createProject.isPending}>创建</Button>
            <Button type="button" onClick={cancelProjectForm}>取消</Button>
          </ProjectForm>
        ) : (
          <ProjectField>
            <ProjectLabel>当前项目</ProjectLabel>
            <ProjectSelect
              ref={projectSelectRef}
              aria-label="当前 Bug 项目"
              value={selectedProjectRef || ''}
              disabled={!projects.length}
              placeholder="暂无项目"
              options={projects.map((project) => ({ value: project.projectRef, label: project.name }))}
              onChange={(value) => onLocationChange({
                ...location,
                projectRef: value,
                recordId: undefined,
                investigationView: 'active',
                caseFilters: defaultBugCaseFilters()
              })}
            />
          </ProjectField>
        )}
        <SectionTabs role="tablist" aria-label="Bug Agent 工作区">
          <button role="tab" aria-selected={location.section === 'investigations'} onClick={() => onLocationChange(sectionLocation('investigations'))}>调查</button>
          <button role="tab" aria-selected={location.section === 'review'} onClick={() => onLocationChange(sectionLocation('review'))}>审核</button>
          <button role="tab" aria-selected={location.section === 'library'} onClick={() => onLocationChange(sectionLocation('library'))}>案例库</button>
        </SectionTabs>
        {creatingProject ? null : <Button type="button" onClick={openProjectForm}>新建项目</Button>}
      </WorkspaceControlBar>
      {projectError && <Alert role="alert">{projectError}</Alert>}
      <Content>
        {projectsQuery.isLoading ? <EmptyStateWrap><p>正在加载 Bug 项目…</p></EmptyStateWrap> : projectsQuery.isError ? (
          <EmptyStateWrap><Alert role="alert">加载 Bug 项目失败。</Alert><Button type="button" onClick={() => void projectsQuery.refetch()}>重新加载</Button></EmptyStateWrap>
        ) : !selectedProjectRef ? (
          <EmptyStateWrap>
            <Empty
              icon="🗂️"
              title="创建第一个 Bug 项目"
              description="项目用于隔离调查、案例和默认检索范围。"
              action={(
                <Button ref={emptyCtaRef} variant="primary" type="button" onClick={openProjectForm}>新建项目</Button>
              )}
            />
            <EmptyHint>创建项目 → 提交证据开始调查 → 验证后沉淀为可检索案例</EmptyHint>
          </EmptyStateWrap>
        ) : location.section === 'investigations' ? (
          <InvestigationWorkspace
            location={location}
            projectRef={selectedProjectRef}
            seed={seed}
            onLocationChange={onLocationChange}
          />
        ) : <BugCaseWorkspace
          mode={location.section}
          location={location}
          projectRef={selectedProjectRef}
          projects={projects}
          onLocationChange={onLocationChange}
        />}
      </Content>
    </Workspace>
  );
}
