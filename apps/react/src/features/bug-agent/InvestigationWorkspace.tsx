import { useState, type FormEvent } from 'react';
import styled from 'styled-components';
import {
  type BugEvidenceInput,
  type BugEvidenceType,
  type BugInvestigation
} from '@/services/bugAgentApi';
import { Empty } from '@/ui/Empty';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';
import type { BugInvestigationSeed } from './BugWorkspace';
import {
  defaultBugCaseFilters,
  type BugInvestigationView,
  type BugWorkspaceLocation
} from './bugViewState';
import {
  investigationMatchesView,
  useBugInvestigation,
  useBugInvestigations,
  useBugMutations
} from './bugQueries';

const evidenceTypes: Array<{ value: BugEvidenceType; label: string }> = [
  { value: 'error', label: '错误与堆栈' },
  { value: 'network', label: '网络请求' },
  { value: 'test_failure', label: '测试失败' },
  { value: 'code', label: '代码片段' },
  { value: 'environment', label: '运行环境' },
  { value: 'reproduction', label: '复现步骤' },
  { value: 'verification', label: '验证结果' },
  { value: 'note', label: '补充记录' }
];

const Pane = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
`;

const PaneHeader = styled.header`
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

const ViewTabs = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);

  button { padding: 0.55rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text-muted); background: var(--color-surface); }
  button[aria-pressed="true"] { color: var(--color-primary); border-color: var(--color-primary-border); background: var(--color-primary-surface); font-weight: 700; }
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
  span { color: var(--color-text-muted); font-size: 0.72rem; }
`;

const Form = styled.form`
  display: grid;
  gap: var(--space-4);
  max-width: 56rem;

  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.76rem; }
  input, textarea, select { width: 100%; padding: 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text); background: var(--color-background); }
  textarea { min-height: 9rem; resize: vertical; line-height: 1.55; }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
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

const Card = styled.section`
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface-muted);

  h3, h4, p { margin: 0; }
  p, li { line-height: 1.6; }
  ul, ol { margin: 0; padding-left: 1.25rem; }
`;

const Status = styled.span`
  display: inline-flex;
  width: fit-content;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  color: var(--color-primary);
  background: var(--color-primary-surface);
  font-size: 0.72rem;
  font-weight: 700;
`;

const FactGrid = styled.dl`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;

  div { min-width: 0; padding: var(--space-3); border-radius: var(--radius-control); background: var(--color-surface); }
  dt { color: var(--color-text-muted); font-size: 0.7rem; }
  dd { margin: 0.3rem 0 0; overflow-wrap: anywhere; }

  @media (max-width: 38rem) { grid-template-columns: 1fr; }
`;

const Alert = styled.p<{ $danger?: boolean }>`
  padding: var(--space-3);
  border-radius: var(--radius-control);
  color: ${({ $danger }) => $danger ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $danger }) => $danger ? 'var(--color-danger-surface)' : 'var(--color-primary-surface)'};
`;

function evidenceLabel(type: BugEvidenceType) {
  return evidenceTypes.find((item) => item.value === type)?.label || type;
}

function dateLabel(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

export function InvestigationWorkspace({
  location,
  projectRef,
  seed,
  onLocationChange
}: {
  location: BugWorkspaceLocation;
  projectRef: string;
  seed?: BugInvestigationSeed;
  onLocationChange: (next: BugWorkspaceLocation, options?: { replace?: boolean }) => void;
}) {
  const recordId = location.recordId;
  const creating = location.creating;
  const view = location.investigationView;
  const investigations = useBugInvestigations(projectRef);
  const list = (investigations.data || []).filter((item) => investigationMatchesView(item.status, view));
  const detail = useBugInvestigation(recordId);
  const mutations = useBugMutations();
  const [title, setTitle] = useState(seed?.title || '');
  const [evidenceType, setEvidenceType] = useState<BugEvidenceType>(seed?.evidence.type || 'error');
  const [evidenceContent, setEvidenceContent] = useState(seed?.evidence.content || '');
  const [appendType, setAppendType] = useState<BugEvidenceType>('note');
  const [appendContent, setAppendContent] = useState('');
  const [error, setError] = useState('');

  function listView(nextView: BugInvestigationView = view): BugWorkspaceLocation {
    return {
      ...location,
      section: 'investigations',
      projectRef,
      recordId: undefined,
      creating: false,
      investigationView: nextView,
      caseFilters: defaultBugCaseFilters()
    };
  }

  function detailView(id: string, nextView: BugInvestigationView = view): BugWorkspaceLocation {
    return {
      ...location,
      section: 'investigations',
      projectRef,
      recordId: id,
      creating: false,
      investigationView: nextView,
      caseFilters: defaultBugCaseFilters()
    };
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!evidenceContent.trim()) return;
    setError('');
    try {
      const item = await mutations.createInvestigation.mutateAsync({
        projectRef,
        ...(title.trim() ? { title: title.trim() } : {}),
        evidence: { type: evidenceType, content: evidenceContent.trim() }
      });
      onLocationChange(detailView(item.id, 'active'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建 Bug 调查失败');
    }
  }

  async function appendAndAnalyze(event: FormEvent) {
    event.preventDefault();
    if (!recordId || !appendContent.trim()) return;
    setError('');
    try {
      await mutations.appendEvidence.mutateAsync({
        id: recordId,
        evidence: { type: appendType, content: appendContent.trim() }
      });
      setAppendContent('');
      await mutations.analyzeInvestigation.mutateAsync(recordId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '证据已保存，但分析未完成');
    }
  }

  async function retryAnalysis() {
    if (!recordId) return;
    setError('');
    try { await mutations.analyzeInvestigation.mutateAsync(recordId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '分析 Bug 证据失败'); }
  }

  async function convert(item: BugInvestigation) {
    setError('');
    try {
      const updated = await mutations.convertInvestigation.mutateAsync(item.id);
      if (updated.candidateBugCaseId) {
        onLocationChange({
          ...location,
          section: 'review',
          projectRef,
          recordId: updated.candidateBugCaseId,
          creating: false,
          investigationView: 'active',
          caseFilters: defaultBugCaseFilters()
        });
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '转为 Candidate 失败'); }
  }

  async function close(item: BugInvestigation) {
    if (!window.confirm(`关闭调查“${item.title}”？关闭后将保留为只读历史。`)) return;
    setError('');
    try {
      const updated = await mutations.closeInvestigation.mutateAsync(item.id);
      onLocationChange(detailView(updated.id, 'history'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '关闭调查失败'); }
  }

  const selected = detail.data;
  const busy = mutations.appendEvidence.isPending || mutations.analyzeInvestigation.isPending
    || mutations.convertInvestigation.isPending || mutations.closeInvestigation.isPending;

  return (
    <MasterDetailLayout
      masterLabel="调查列表"
      detailLabel="调查详情"
      masterWidth="21rem"
      mobilePane={recordId || creating ? 'detail' : 'master'}
      master={(
        <Pane>
          <PaneHeader><div><h2>调查</h2><p>{list.length} 项</p></div></PaneHeader>
          <Scroll>
            <ViewTabs aria-label="调查状态">
              <button type="button" aria-pressed={view === 'active'} onClick={() => onLocationChange(listView('active'))}>进行中</button>
              <button type="button" aria-pressed={view === 'history'} onClick={() => onLocationChange(listView('history'))}>历史</button>
            </ViewTabs>
            {investigations.isLoading ? <p>正在加载调查…</p> : investigations.isError ? <Alert $danger>加载调查失败。</Alert> : list.length ? list.map((item) => (
              <ListButton key={item.id} type="button" aria-current={item.id === recordId} onClick={() => onLocationChange(detailView(item.id))}>
                <strong>{item.title}</strong>
                <Status>{item.status === 'draft' ? '调查中' : item.status === 'converted' ? '已转换' : '已关闭'}</Status>
                <span>{dateLabel(item.updatedAt)}</span>
              </ListButton>
            )) : <Empty title={view === 'active' ? '当前项目还没有调查。' : '还没有历史调查。'} description="新建调查后，可以持续补充证据并形成候选案例。" />}
          </Scroll>
        </Pane>
      )}
      detail={(
        <Pane>
          {creating ? (
            <>
              <PaneHeader><div><h2>新建调查</h2><p>首条证据提交后才会保存。</p></div><Button type="button" onClick={() => onLocationChange(listView())}>返回列表</Button></PaneHeader>
              <Scroll>
                <Form onSubmit={create}>
                  <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：支付回调持续返回 500" /></label>
                  <label>首条证据类型<select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value as BugEvidenceType)}>{evidenceTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                  <label>证据内容<textarea value={evidenceContent} onChange={(event) => setEvidenceContent(event.target.value)} placeholder="粘贴错误、日志、复现步骤或相关代码" /></label>
                  {error && <Alert $danger role="alert">{error}</Alert>}
                  <Actions><Button $primary type="submit" disabled={!evidenceContent.trim() || mutations.createInvestigation.isPending}>{mutations.createInvestigation.isPending ? '正在创建调查…' : '创建并分析'}</Button></Actions>
                </Form>
              </Scroll>
            </>
          ) : recordId ? detail.isLoading ? <Scroll><p>正在加载调查详情…</p></Scroll> : detail.isError || !selected ? <Scroll><Alert $danger>调查不存在或暂时无法加载。</Alert><Button type="button" onClick={() => onLocationChange(listView())}>返回调查列表</Button></Scroll> : (
            <>
              <PaneHeader>
                <div><Status>{selected.status}</Status><h2>{selected.title}</h2><p>更新于 {dateLabel(selected.updatedAt)}</p></div>
                <Actions>
                  <Button type="button" onClick={() => onLocationChange(listView())}>返回列表</Button>
                  {selected.status === 'draft' && <Button $primary type="button" disabled={!selected.candidateReadiness.ready || busy} onClick={() => void convert(selected)}>转为 Candidate</Button>}
                  {selected.status === 'draft' && <Button $danger type="button" disabled={busy} onClick={() => void close(selected)}>关闭调查</Button>}
                </Actions>
              </PaneHeader>
              <Scroll>
                {error && <Alert $danger role="alert">{error}</Alert>}
                <Card>
                  <h3>当前判断</h3>
                  <Status>证据质量：{selected.analysis.evidenceQuality}</Status>
                  <p>{selected.analysis.summary || '服务端尚未形成分析摘要。'}</p>
                  {selected.analysis.nextAction && <p><strong>{selected.analysis.nextAction.title}：</strong>{selected.analysis.nextAction.description}</p>}
                  {!selected.candidateReadiness.ready && <ul>{selected.candidateReadiness.checks.filter((check) => !check.passed).map((check) => <li key={check.key}>{check.label}</li>)}</ul>}
                </Card>

                {selected.status === 'draft' && (
                  <Card>
                    <h3>补充现场并重新分析</h3>
                    <Form onSubmit={appendAndAnalyze}>
                      <label>证据类型<select value={appendType} onChange={(event) => setAppendType(event.target.value as BugEvidenceType)}>{evidenceTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                      <label>证据内容<textarea value={appendContent} onChange={(event) => setAppendContent(event.target.value)} /></label>
                      <Actions>
                        <Button $primary type="submit" disabled={!appendContent.trim() || busy}>{busy ? '处理中…' : '保存证据并分析'}</Button>
                        <Button type="button" disabled={busy} onClick={() => void retryAnalysis()}>只重试分析</Button>
                      </Actions>
                    </Form>
                  </Card>
                )}

                <Card>
                  <h3>确定性 Facts</h3>
                  <FactGrid>
                    <div><dt>错误类型</dt><dd>{selected.facts.errorTypes.join('、') || '未识别'}</dd></div>
                    <div><dt>错误信息</dt><dd>{selected.facts.messages.join('、') || '未识别'}</dd></div>
                    <div><dt>文件与位置</dt><dd>{[...selected.facts.files, ...selected.facts.locations].join('、') || '未识别'}</dd></div>
                    <div><dt>语言与框架</dt><dd>{[...(selected.facts.languages || []), ...selected.facts.frameworks].join('、') || '未识别'}</dd></div>
                    <div><dt>环境</dt><dd>{selected.facts.environments.join('、') || '未识别'}</dd></div>
                    <div><dt>错误签名</dt><dd>{selected.facts.errorSignatures.join('、') || '未识别'}</dd></div>
                  </FactGrid>
                </Card>

                <Card><h3>Hypotheses</h3>{selected.analysis.hypotheses.length ? selected.analysis.hypotheses.map((hypothesis) => <article key={hypothesis.title}><strong>{hypothesis.title}</strong><p>{hypothesis.reasoning}</p><Status>{hypothesis.confidenceLabel}</Status></article>) : <p>当前没有足够证据形成假设。</p>}</Card>
                <Card><h3>验证步骤</h3>{selected.analysis.verificationSteps.length ? <ol>{selected.analysis.verificationSteps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.instruction}</p></li>)}</ol> : <p>暂无验证步骤。</p>}</Card>
                {selected.analysis.missingEvidence.length > 0 && <Card><h3>仍缺少的证据</h3><ul>{selected.analysis.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul></Card>}
                {selected.analysis.similarCases.length > 0 && <Card><h3>相似已确认案例</h3>{selected.analysis.similarCases.map((item) => <article key={item.id}><strong>{item.title}</strong><p>{item.symptom}</p><Status>{item.matchedChannels.join(' + ')} · {item.score.toFixed(2)}</Status></article>)}</Card>}
                <Card><h3>已保存证据</h3>{selected.evidence.map((item) => <details key={item.id}><summary>{evidenceLabel(item.type)} · {dateLabel(item.createdAt)}</summary><pre>{item.content}</pre></details>)}</Card>
                <Card><details><summary>技术详情与分析运行记录</summary><p>策略：{selected.analysis.policyVersion || 'unknown'} · 原因：{selected.analysis.reasonCode || 'none'}</p><ul>{selected.runs.map((run) => <li key={run.id}>{run.status} · {run.mode} · {run.durationMs}ms</li>)}</ul></details></Card>
              </Scroll>
            </>
          ) : <Scroll><Empty title="选择一项调查" description="从左侧打开调查，或新建一项调查。" /></Scroll>}
        </Pane>
      )}
    />
  );
}
