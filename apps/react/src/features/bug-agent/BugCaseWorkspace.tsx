import { useEffect, useMemo, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import {
  type BugCase,
  type BugCaseDraft,
  type BugProject,
  type BugResolutionType,
  type BugReviewStatus,
  type BugScope,
  type BugSearchResult,
  type BugSearchRequest
} from '@/services/bugAgentApi';
import { Empty } from '@/ui/Empty';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';
import { Select } from '@/ui/Select';
import {
  defaultBugCaseFilters,
  type BugCaseFilters,
  type BugWorkspaceLocation
} from './bugViewState';
import { useBugCase, useBugCases, useBugMutations, useBugSearch } from './bugQueries';

const Pane = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);

  h2, h3 { margin: 0; font-size: 0.95rem; }
  p { margin: 0.25rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }
`;

const Scroll = styled.div`
  display: grid;
  align-content: start;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
`;

const Filters = styled.div`
  display: grid;
  gap: var(--space-2);

  label { display: grid; gap: var(--space-1); color: var(--color-text-muted); font-size: 0.7rem; }
  input, textarea { width: 100%; min-height: 2.5rem; padding: 0.55rem 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text); background: var(--color-surface); }
`;

const ListButton = styled.button`
  display: grid;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-3);
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);

  &[aria-current="true"] { border-color: var(--color-primary-border); background: var(--color-primary-surface); }
  small { color: var(--color-text-muted); }
`;

const StatusRow = styled.span`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
`;

const Status = styled.span`
  display: inline-flex;
  width: fit-content;
  padding: 0.22rem 0.5rem;
  border-radius: 999px;
  color: var(--color-primary);
  background: var(--color-primary-surface);
  font-size: 0.68rem;
  font-weight: 700;
`;

const Button = styled.button<{ $primary?: boolean; $danger?: boolean }>`
  min-height: 2.5rem;
  padding: 0.55rem 0.85rem;
  border: 1px solid ${({ $danger, $primary }) => $danger ? 'var(--color-danger-border)' : $primary ? 'var(--color-primary)' : 'var(--color-border)'};
  border-radius: var(--radius-control);
  color: ${({ $danger, $primary }) => $danger ? 'var(--color-danger)' : $primary ? 'white' : 'var(--color-text)'};
  background: ${({ $danger, $primary }) => $danger ? 'var(--color-danger-surface)' : $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
  &:disabled { opacity: 0.55; }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
`;

const Form = styled.form`
  display: grid;
  gap: var(--space-4);

  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }
  input, textarea { width: 100%; padding: 0.65rem 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text); background: var(--color-background); }
  textarea { min-height: 5.5rem; resize: vertical; line-height: 1.5; }
`;

const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  @media (max-width: 42rem) { grid-template-columns: 1fr; }
`;

const Card = styled.section`
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface-muted);

  h3, h4, p { margin: 0; }
  p, li { line-height: 1.6; overflow-wrap: anywhere; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  blockquote { margin: 0; padding-left: var(--space-3); border-left: 3px solid var(--color-primary-border); }
  dl { display: grid; gap: var(--space-3); margin: 0; }
  dt { color: var(--color-text-muted); font-size: 0.72rem; }
  dd { margin: 0.2rem 0 0; white-space: pre-wrap; }
`;

const SearchBar = styled.form`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);

  input { min-height: 2.65rem; padding: 0.6rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
`;

const Alert = styled.p<{ $danger?: boolean }>`
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-control);
  color: ${({ $danger }) => $danger ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $danger }) => $danger ? 'var(--color-danger-surface)' : 'var(--color-primary-surface)'};
`;

type DraftFields = {
  title: string; symptom: string; errorSignatures: string; reproductionSteps: string;
  language: string; framework: string; versions: string; module: string; environment: string;
  resolutionType: BugResolutionType; rootCause: string; fix: string; workaroundRisks: string;
  applicability: string; verification: string; tags: string; sourceRefs: string;
};

function lines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function fieldsFrom(item?: BugCase): DraftFields {
  return {
    title: item?.title || '', symptom: item?.symptom || '',
    errorSignatures: item?.errorSignatures.join('\n') || '',
    reproductionSteps: item?.reproductionSteps.join('\n') || '',
    language: item?.context.language || '', framework: item?.context.framework || '',
    versions: item?.context.versions.join('\n') || '', module: item?.context.module || '',
    environment: item?.context.environment || '', resolutionType: item?.resolutionType || 'root_cause_fix',
    rootCause: item?.rootCause || '', fix: item?.fix || '',
    workaroundRisks: item?.workaroundRisks.join('\n') || '', applicability: item?.applicability.join('\n') || '',
    verification: item?.verification || '', tags: item?.tags.join('\n') || '', sourceRefs: item?.sourceRefs.join('\n') || ''
  };
}

function draftFrom(fields: DraftFields, projectRef: string): BugCaseDraft {
  return {
    sourceProjectRef: projectRef,
    title: fields.title.trim(), symptom: fields.symptom.trim(),
    errorSignatures: lines(fields.errorSignatures), reproductionSteps: lines(fields.reproductionSteps),
    context: {
      language: fields.language.trim(), framework: fields.framework.trim(), versions: lines(fields.versions),
      module: fields.module.trim(), environment: fields.environment.trim()
    },
    resolutionType: fields.resolutionType,
    rootCause: fields.resolutionType === 'root_cause_fix' ? fields.rootCause.trim() || null : null,
    fix: fields.fix.trim(), workaroundRisks: lines(fields.workaroundRisks),
    applicability: lines(fields.applicability), verification: fields.verification.trim(),
    tags: lines(fields.tags), sourceRefs: lines(fields.sourceRefs)
  };
}

function BugCaseForm({ item, projectRef, busy, onSubmit }: {
  item?: BugCase;
  projectRef: string;
  busy: boolean;
  onSubmit: (draft: BugCaseDraft) => Promise<void>;
}) {
  const [fields, setFields] = useState(() => fieldsFrom(item));
  const set = (name: keyof DraftFields, value: string) => setFields((current) => ({ ...current, [name]: value }));

  return (
    <Form onSubmit={(event) => { event.preventDefault(); void onSubmit(draftFrom(fields, projectRef)); }}>
      <FieldGrid>
        <label>标题<input value={fields.title} onChange={(event) => set('title', event.target.value)} /></label>
        <label>解决类型<Select value={fields.resolutionType} onChange={(value) => set('resolutionType', value)} options={[{ value: 'root_cause_fix', label: '根因修复' }, { value: 'verified_workaround', label: '已验证临时方案' }]} /></label>
      </FieldGrid>
      <label>症状<textarea value={fields.symptom} onChange={(event) => set('symptom', event.target.value)} /></label>
      <FieldGrid>
        <label>错误签名（每行一项）<textarea value={fields.errorSignatures} onChange={(event) => set('errorSignatures', event.target.value)} /></label>
        <label>复现步骤（每行一步）<textarea value={fields.reproductionSteps} onChange={(event) => set('reproductionSteps', event.target.value)} /></label>
      </FieldGrid>
      <FieldGrid>
        <label>语言<input value={fields.language} onChange={(event) => set('language', event.target.value)} /></label>
        <label>框架<input value={fields.framework} onChange={(event) => set('framework', event.target.value)} /></label>
        <label>模块<input value={fields.module} onChange={(event) => set('module', event.target.value)} /></label>
        <label>环境<input value={fields.environment} onChange={(event) => set('environment', event.target.value)} /></label>
      </FieldGrid>
      {fields.resolutionType === 'root_cause_fix' && <label>根因<textarea value={fields.rootCause} onChange={(event) => set('rootCause', event.target.value)} /></label>}
      <label>修复或方案<textarea value={fields.fix} onChange={(event) => set('fix', event.target.value)} /></label>
      <label>验证方式<textarea value={fields.verification} onChange={(event) => set('verification', event.target.value)} /></label>
      <FieldGrid>
        <label>适用版本（每行一项）<textarea value={fields.versions} onChange={(event) => set('versions', event.target.value)} /></label>
        <label>标签（每行一项）<textarea value={fields.tags} onChange={(event) => set('tags', event.target.value)} /></label>
        <label>临时方案风险（每行一项）<textarea value={fields.workaroundRisks} onChange={(event) => set('workaroundRisks', event.target.value)} /></label>
        <label>适用范围（每行一项）<textarea value={fields.applicability} onChange={(event) => set('applicability', event.target.value)} /></label>
      </FieldGrid>
      <label>来源引用（每行一项）<textarea value={fields.sourceRefs} onChange={(event) => set('sourceRefs', event.target.value)} /></label>
      <Actions><Button $primary type="submit" disabled={busy || !fields.title.trim() || !fields.symptom.trim() || !fields.fix.trim()}>{busy ? '保存中…' : item ? '保存修改' : '创建 Candidate'}</Button></Actions>
    </Form>
  );
}

function CaseDetail({ item, result }: { item: BugCase; result?: BugSearchResult }) {
  return (
    <>
      <Card>
        <StatusRow><Status>{item.reviewStatus}</Status><Status>{item.status}</Status><Status>{item.scope}</Status></StatusRow>
        <dl>
          <div><dt>症状</dt><dd>{item.symptom}</dd></div>
          <div><dt>根因</dt><dd>{item.rootCause || '使用已验证临时方案，未声明根因。'}</dd></div>
          <div><dt>修复</dt><dd>{item.fix}</dd></div>
          <div><dt>验证</dt><dd>{item.verification}</dd></div>
          <div><dt>上下文</dt><dd>{[item.context.language, item.context.framework, item.context.module, item.context.environment].filter(Boolean).join(' · ')}</dd></div>
        </dl>
      </Card>
      {item.reviewReason && <Card><h3>最近审核</h3><p>{item.reviewedBy || '服务端用户'}：{item.reviewReason}</p></Card>}
      {result && <Card><h3>检索匹配</h3><p>{result.matchedChannels.join(' + ')} · 得分 {result.score.toFixed(2)}</p>{result.citations.length ? result.citations.map((citation) => <blockquote key={citation.id}>{citation.headingPath.join(' / ')}<p>{citation.snippet}</p><Status>{citation.channel}</Status></blockquote>) : <p>该结果没有额外引用片段。</p>}</Card>}
      {item.error && <Alert $danger>{item.error}</Alert>}
    </>
  );
}

export function BugCaseWorkspace({
  mode,
  location,
  projectRef,
  projects,
  onLocationChange
}: {
  mode: 'review' | 'library';
  location: BugWorkspaceLocation;
  projectRef: string;
  projects: BugProject[];
  onLocationChange: (next: BugWorkspaceLocation, options?: { replace?: boolean }) => void;
}) {
  const recordId = location.recordId;
  const creating = location.creating;
  const caseFilters = location.caseFilters;
  const scope = caseFilters.scope;
  const reviewStatus = caseFilters.reviewStatus;
  const processingStatus = caseFilters.processingStatus;
  const language = caseFilters.language;
  const framework = caseFilters.framework;
  const query = caseFilters.query;
  const includeCommon = caseFilters.includeCommon;
  const extraProjects = caseFilters.additionalProjectRefs;
  const [searchDraft, setSearchDraft] = useState(query);
  const [reviewReason, setReviewReason] = useState('');
  const [error, setError] = useState('');
  const mutations = useBugMutations();

  const reviewFilters = useMemo(() => ({
    ...(scope !== 'common' ? { sourceProjectRef: projectRef } : {}),
    ...(scope ? { scope } : {}),
    reviewStatuses: [reviewStatus],
    ...(processingStatus ? { statuses: [processingStatus] } : {})
  }), [processingStatus, projectRef, reviewStatus, scope]);
  const confirmedFilters = useMemo(() => ({
    reviewStatuses: ['confirmed' as const], statuses: ['ready' as const]
  }), []);
  const listQuery = useBugCases(mode === 'review' ? reviewFilters : confirmedFilters);
  const searchRequest = useMemo<BugSearchRequest | undefined>(() => query.trim() ? {
    query: query.trim(), projectRef, includeCommon, additionalProjectRefs: extraProjects,
    filters: { ...(language ? { language } : {}), ...(framework ? { framework } : {}) }, topK: 20
  } : undefined, [extraProjects.join(','), framework, includeCommon, language, projectRef, query]);
  const searchQuery = useBugSearch(mode === 'library' ? searchRequest : undefined);
  const detail = useBugCase(recordId);

  const cases = (listQuery.data || []).filter((item) => {
    if (mode === 'library' && item.scope !== 'common' && item.sourceProjectRef !== projectRef && !extraProjects.includes(item.sourceProjectRef)) return false;
    if (mode === 'library' && item.scope === 'common' && !includeCommon) return false;
    return (!language || item.context.language === language) && (!framework || item.context.framework === framework);
  });
  const rows = mode === 'library' && searchRequest
    ? (searchQuery.data?.results || []).map((result) => ({ item: result.bugCase, meta: `${result.matchedChannels.join(' + ')} · ${result.score.toFixed(2)}` }))
    : cases.map((item) => ({ item, meta: `${item.context.language || '未知语言'} · ${item.context.framework || '未知框架'}` }));
  const selected = detail.data;
  const selectedSearchResult = searchQuery.data?.results.find((result) => result.bugCase.id === selected?.id);

  useEffect(() => { setReviewReason(selected?.reviewReason || ''); }, [selected?.id, selected?.reviewReason]);
  useEffect(() => { setSearchDraft(query); }, [query]);

  function listLocation(): BugWorkspaceLocation {
    return { ...location, recordId: undefined, creating: false };
  }

  function detailLocation(id: string): BugWorkspaceLocation {
    return { ...location, recordId: id, creating: false };
  }

  function filteredLocation(patch: Partial<BugCaseFilters>): BugWorkspaceLocation {
    return { ...location, recordId: undefined, creating: false, caseFilters: { ...caseFilters, ...patch } };
  }

  function freshLocation(section: 'review' | 'library', recordId?: string, filterPatch: Partial<BugCaseFilters> = {}): BugWorkspaceLocation {
    return {
      ...location,
      section,
      projectRef,
      recordId,
      creating: false,
      investigationView: 'active',
      caseFilters: { ...defaultBugCaseFilters(), ...filterPatch }
    };
  }

  async function saveCase(draft: BugCaseDraft) {
    setError('');
    try {
      if (selected) await mutations.updateCase.mutateAsync({ id: selected.id, patch: draft });
      else {
        const created = await mutations.createCase.mutateAsync(draft);
        onLocationChange(freshLocation('review', created.id));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存 BugCase 失败'); }
  }

  async function review(status: 'confirmed' | 'rejected') {
    if (!selected || !reviewReason.trim()) return;
    if (status === 'rejected' && !window.confirm(`拒绝案例“${selected.title}”？`)) return;
    setError('');
    try {
      const updated = await mutations.reviewCase.mutateAsync({ id: selected.id, reviewStatus: status, reviewReason: reviewReason.trim() });
      if (status === 'confirmed') onLocationChange(freshLocation('library', updated.id));
      else onLocationChange(freshLocation('review', updated.id, { reviewStatus: 'rejected' }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '审核 BugCase 失败'); }
  }

  async function remove() {
    if (!selected || !window.confirm(`永久删除案例“${selected.title}”？此操作无法撤销。`)) return;
    setError('');
    try { await mutations.deleteCase.mutateAsync(selected.id); onLocationChange(listLocation()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '删除 BugCase 失败'); }
  }

  async function promote() {
    if (!selected || !window.confirm(`将“${selected.title}”移动到公共案例库？`)) return;
    setError('');
    try { await mutations.promoteCase.mutateAsync(selected.id); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '提升公共案例失败'); }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    onLocationChange({ ...filteredLocation({ query: searchDraft.trim() }), section: 'library' });
  }

  const busy = Object.values(mutations).some((mutation) => mutation.isPending);

  return (
    <Pane>
      {mode === 'library' && (
        <SearchBar onSubmit={submitSearch}>
          <input aria-label="搜索 Bug 案例" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="描述错误、症状或已尝试方案" />
          <Button $primary type="submit">搜索</Button>
        </SearchBar>
      )}
      <MasterDetailLayout
        masterLabel={mode === 'review' ? 'BugCase 审核列表' : '案例库列表'}
        detailLabel="BugCase 详情"
        mobilePane={recordId || creating ? 'detail' : 'master'}
        master={(
          <Pane>
            <Header><div><h2>{mode === 'review' ? '审核队列' : query ? '检索结果' : '已确认案例'}</h2><p>{rows.length} 项</p></div><Actions><Button type="button" onClick={() => void (searchRequest ? searchQuery.refetch() : listQuery.refetch())}>刷新</Button>{mode === 'review' && <Button $primary type="button" onClick={() => onLocationChange({ ...freshLocation('review'), creating: true })}>手动新建</Button>}</Actions></Header>
            <Scroll>
              <Filters>
                {mode === 'review' && <label>审核状态<Select value={reviewStatus} onChange={(value) => onLocationChange(filteredLocation({ reviewStatus: value as BugReviewStatus }))} options={[{ value: 'candidate', label: '待审核' }, { value: 'confirmed', label: '已确认' }, { value: 'rejected', label: '已拒绝' }]} /></label>}
                {mode === 'review' && <label>范围<Select value={scope || ''} onChange={(value) => onLocationChange(filteredLocation({ scope: (value || undefined) as BugScope | undefined }))} options={[{ value: '', label: '全部' }, { value: 'project', label: '当前项目' }, { value: 'common', label: '公共库' }]} /></label>}
                {mode === 'library' && <label><span><input type="checkbox" checked={includeCommon} onChange={(event) => onLocationChange(filteredLocation({ includeCommon: event.target.checked }))} /> 包含公共库</span></label>}
                <label>语言<input value={language} onChange={(event) => onLocationChange(filteredLocation({ language: event.target.value }))} placeholder="全部语言" /></label>
                <label>框架<input value={framework} onChange={(event) => onLocationChange(filteredLocation({ framework: event.target.value }))} placeholder="全部框架" /></label>
                {mode === 'library' && projects.filter((project) => project.projectRef !== projectRef).length > 0 && <details><summary>额外项目范围</summary>{projects.filter((project) => project.projectRef !== projectRef).map((project) => <label key={project.projectRef}><span><input type="checkbox" checked={extraProjects.includes(project.projectRef)} onChange={(event) => { const next = event.target.checked ? [...extraProjects, project.projectRef] : extraProjects.filter((ref) => ref !== project.projectRef); onLocationChange(filteredLocation({ additionalProjectRefs: next.sort() })); }} /> {project.name}</span></label>)}</details>}
              </Filters>
              {mode === 'library' && searchQuery.data?.trace.degradedChannels.length ? <Alert>部分检索通道已降级：{searchQuery.data.trace.degradedChannels.join('、')}</Alert> : null}
              {(listQuery.isLoading || searchQuery.isLoading) ? <p>正在加载案例…</p> : (listQuery.isError || searchQuery.isError) ? <Alert $danger>加载案例失败，请重试。</Alert> : rows.length ? rows.map(({ item, meta }) => (
                <ListButton key={item.id} type="button" aria-current={item.id === recordId} onClick={() => onLocationChange(detailLocation(item.id))}>
                  <strong>{item.title}</strong><StatusRow><Status>{item.reviewStatus}</Status><Status>{item.status}</Status><Status>{item.scope}</Status></StatusRow><small>{meta}</small>
                </ListButton>
              )) : <Empty title={mode === 'review' ? '没有符合条件的 BugCase。' : query ? '没有找到匹配案例。' : '当前范围还没有已确认案例。'} />}
            </Scroll>
          </Pane>
        )}
        detail={(
          <Pane>
            {creating && mode === 'review' ? <><Header><div><h2>手动创建 BugCase</h2><p>创建后进入 Candidate 审核队列。</p></div><Button type="button" onClick={() => onLocationChange(listLocation())}>返回列表</Button></Header><Scroll>{error && <Alert $danger>{error}</Alert>}<BugCaseForm projectRef={projectRef} busy={busy} onSubmit={saveCase} /></Scroll></>
              : recordId ? detail.isLoading ? <Scroll><p>正在加载案例详情…</p></Scroll> : detail.isError || !selected ? <Scroll><Alert $danger>案例不存在或暂时无法加载。</Alert><Button type="button" onClick={() => onLocationChange(listLocation())}>返回列表</Button></Scroll> : <><Header><div><h2>{selected.title}</h2><p>{selected.sourceProjectRef}</p></div><Actions><Button type="button" onClick={() => onLocationChange(listLocation())}>返回列表</Button><Button type="button" onClick={() => void detail.refetch()}>刷新</Button>{selected.scope === 'project' && selected.reviewStatus === 'confirmed' && <Button type="button" onClick={() => void promote()}>提升公共库</Button>}<Button $danger type="button" onClick={() => void remove()}>永久删除</Button></Actions></Header><Scroll>{error && <Alert $danger role="alert">{error}</Alert>}{mode === 'review' ? <><BugCaseForm key={`${selected.id}-${selected.updatedAt}`} item={selected} projectRef={projectRef} busy={busy} onSubmit={saveCase} /><Card><h3>人工审核</h3><label>审核原因<textarea aria-label="审核原因" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></label><Actions>{selected.reviewStatus === 'candidate' && <Button $primary type="button" disabled={!reviewReason.trim() || busy} onClick={() => void review('confirmed')}>确认案例</Button>}{selected.reviewStatus !== 'rejected' && <Button $danger type="button" disabled={!reviewReason.trim() || busy} onClick={() => void review('rejected')}>拒绝案例</Button>}</Actions></Card></> : <CaseDetail item={selected} result={selectedSearchResult} />}</Scroll></>
              : <Scroll><Empty title={mode === 'review' ? '选择一个 BugCase' : '选择一个已确认案例'} description="从左侧列表打开详情。" /></Scroll>}
          </Pane>
        )}
      />
    </Pane>
  );
}
