import { useEffect, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import type { BugEvidenceInput } from '@/services/bugAgentApi';
import { Empty } from '@/ui/Empty';
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

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  h1 { margin: 0; font-size: 1.15rem; }
  p { margin: 0.25rem 0 0; color: var(--color-text-muted); font-size: 0.8rem; }
`;

const Button = styled.button<{ $primary?: boolean }>`
  min-height: 2.5rem;
  padding: 0.55rem 0.8rem;
  border: 1px solid ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: var(--radius-control);
  color: ${({ $primary }) => $primary ? 'white' : 'var(--color-text)'};
  background: ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
  font-size: 0.875rem;
`;

const ProjectField = styled.label`
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);

  select {
    min-width: 0;
    flex: 1;
  }
`;

const ProjectLabel = styled.span`
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;

const ProjectForm = styled.form`
  display: flex;
  flex: 1;
  min-width: 0;
  gap: var(--space-2);

  input {
    min-width: 0;
    flex: 1;
  }

  @media (max-width: 48rem) {
    flex-basis: 100%;
  }
`;

const Tabs = styled.div`
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);

  button { min-height: 2.5rem; padding: 0.45rem 0.9rem; border: 0; border-radius: var(--radius-control); white-space: nowrap; color: var(--color-text-muted); background: transparent; }
  button[aria-selected="true"] { color: var(--color-primary); background: var(--color-primary-surface); font-weight: 700; }
`;

const Content = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`;

const EmptyWrap = styled.div`padding: var(--space-5);`;
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
      <Header>
        <div><h1>Bug Agent</h1><p>用证据推进调查，把验证过的问题沉淀为可检索案例。</p></div>
        <Button
          $primary
          type="button"
          disabled={!selectedProjectRef}
          onClick={() => onLocationChange({ ...sectionLocation('investigations'), creating: true })}
        >新建调查</Button>
      </Header>
      <WorkspaceControlBar>
        <ProjectField>
          <ProjectLabel>当前项目</ProjectLabel>
          <select
            aria-label="当前 Bug 项目"
            value={selectedProjectRef || ''}
            onChange={(event) => onLocationChange({
              ...location,
              projectRef: event.target.value,
              recordId: undefined,
              investigationView: 'active',
              caseFilters: defaultBugCaseFilters()
            })}
          >
            {!projects.length && <option value="">暂无项目</option>}
            {projects.map((project) => <option key={project.projectRef} value={project.projectRef}>{project.name}</option>)}
          </select>
        </ProjectField>
        {creatingProject ? (
          <ProjectForm onSubmit={createProject}>
            <input autoFocus aria-label="新项目名称" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="项目名称" />
            <Button $primary type="submit" disabled={!projectName.trim() || mutations.createProject.isPending}>创建</Button>
            <Button type="button" onClick={() => setCreatingProject(false)}>取消</Button>
          </ProjectForm>
        ) : <Button type="button" onClick={() => setCreatingProject(true)}>新建项目</Button>}
      </WorkspaceControlBar>
      {projectError && <Alert role="alert">{projectError}</Alert>}
      <Tabs role="tablist" aria-label="Bug Agent 工作区">
        <button role="tab" aria-selected={location.section === 'investigations'} onClick={() => onLocationChange(sectionLocation('investigations'))}>调查</button>
        <button role="tab" aria-selected={location.section === 'review'} onClick={() => onLocationChange(sectionLocation('review'))}>审核</button>
        <button role="tab" aria-selected={location.section === 'library'} onClick={() => onLocationChange(sectionLocation('library'))}>案例库</button>
      </Tabs>
      <Content>
        {projectsQuery.isLoading ? <EmptyWrap><p>正在加载 Bug 项目…</p></EmptyWrap> : projectsQuery.isError ? (
          <EmptyWrap><Alert role="alert">加载 Bug 项目失败。</Alert><Button type="button" onClick={() => void projectsQuery.refetch()}>重新加载</Button></EmptyWrap>
        ) : !selectedProjectRef ? (
          <EmptyWrap><Empty title="先创建一个 Bug 项目" description="项目用于隔离调查、案例和默认检索范围。" /></EmptyWrap>
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
