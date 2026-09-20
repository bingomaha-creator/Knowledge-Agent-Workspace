import { useMemo, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import { Button } from '@/ui/Button';
import { Empty } from '@/ui/Empty';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { Feedback } from '@/ui/Feedback';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';
import { PaneHeader } from '@/ui/PaneHeader';
import { SafeMarkdown } from '@/ui/SafeMarkdown';
import type { ResearchNewMode, ResearchNewRun, ResearchNewStatus } from '@/services/researchNewApi';
import {
  useResearchNewCapabilities,
  useResearchNewKnowledgeBases,
  useResearchNewMutations,
  useResearchNewRun,
  useResearchNewRuns
} from './researchNewQueries';

type Props = {
  selectedRunId?: string;
  onSelectRun: (id?: string) => void;
};

const STATUS_LABELS: Record<ResearchNewStatus, string> = {
  queued: '等待中', running: '研究中', completed: '已完成', failed: '失败', cancelled: '已取消'
};
const STAGE_LABELS: Record<string, string> = {
  planning: '制定计划', researching: '检索与阅读', assessing: '评估证据', reporting: '生成报告',
  verifying: '验证交付', completed: '已完成'
};
const QUALITY_LABELS = {
  pending: '待评估', sufficient: '证据充足', limited: '证据有限', insufficient: '证据不足'
};

const Shell = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
`;
const Pane = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: var(--color-surface);
`;
const Scroll = styled.div`
  min-height: 0;
  flex: 1;
  padding: var(--space-4);
  overflow-y: auto;
`;
const RunList = styled.div`display: grid; gap: var(--space-2);`;
const RunButton = styled.button`
  display: grid;
  width: 100%;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  text-align: left;
  &[aria-current='true'] { border-color: var(--color-primary-border); background: var(--color-primary-surface); }
  &:hover { border-color: var(--color-primary-border); }
`;
const RunQuestion = styled.strong`
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;
const Status = styled.span<{ $status?: string }>`
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  color: ${({ $status }) => $status === 'failed' ? 'var(--color-danger)' : $status === 'completed' ? 'var(--color-success)' : 'var(--color-primary)'};
  background: ${({ $status }) => $status === 'failed' ? 'var(--color-danger-surface)' : $status === 'completed' ? 'var(--color-success-surface)' : 'var(--color-primary-surface)'};
  font-weight: 700;
`;
const Stack = styled.div`display: grid; gap: var(--space-4);`;
const Card = styled.section`
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);
  h2, h3 { margin: 0; color: var(--color-text); }
  h2 { font-size: 1.125rem; }
  h3 { font-size: 0.9375rem; }
  p { margin: 0; }
`;
const Form = styled.form`display: grid; gap: var(--space-4);`;
const Field = styled.label`
  display: grid;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: 0.8125rem;
  font-weight: 700;
  textarea {
    min-height: 8rem;
    resize: vertical;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    line-height: 1.6;
  }
`;
const ModeGroup = styled.div`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2);`;
const ModeButton = styled.button`
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  text-align: left;
  &[aria-pressed='true'] { border-color: var(--color-primary-border); background: var(--color-primary-surface); }
  strong, small { display: block; }
  small { margin-top: 0.25rem; color: var(--color-text-muted); font-weight: 400; }
`;
const CheckList = styled.div`
  display: grid;
  gap: var(--space-2);
  label { display: flex; align-items: flex-start; gap: var(--space-2); font-weight: 500; }
  small { display: block; color: var(--color-text-muted); }
`;
const Metrics = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  div { padding: var(--space-3); border-radius: var(--radius-control); background: var(--color-surface-muted); }
  dt { color: var(--color-text-muted); font-size: 0.6875rem; }
  dd { margin: 0.25rem 0 0; font-weight: 750; }
`;
const Progress = styled.progress`width: 100%; height: 0.5rem; margin-top: var(--space-3); accent-color: var(--color-primary);`;
const TrackList = styled.div`display: grid; gap: var(--space-3); margin-top: var(--space-3);`;
const Track = styled.article`
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--color-surface-muted);
  p { margin-top: 0.35rem; color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.5; }
  ul { margin: 0.5rem 0 0; padding-left: 1.1rem; color: var(--color-danger); font-size: 0.75rem; }
`;
const Report = styled(SafeMarkdown)`
  color: var(--color-text);
  line-height: 1.72;
  h1 { font-size: 1.45rem; }
  h2 { margin-top: 1.6rem; font-size: 1.15rem; }
  h3 { margin-top: 1.25rem; font-size: 1rem; }
  a { color: var(--color-primary); }
  pre { overflow-x: auto; }
`;
const Sources = styled.ol`
  display: grid;
  gap: var(--space-3);
  margin: var(--space-3) 0 0;
  padding-left: 1.25rem;
  li { padding-left: 0.25rem; }
  a { color: var(--color-primary); word-break: break-all; }
  p { margin-top: 0.25rem; color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.5; }
`;
const Diagnostic = styled.details`
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  summary { cursor: pointer; font-weight: 700; }
  pre { overflow: auto; color: var(--color-text-muted); font-size: 0.6875rem; white-space: pre-wrap; }
`;
const MobileBack = styled(Button)`
  display: none;
  @media (max-width: 48rem) { display: inline-flex; }
`;

function formatTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function NewResearchForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<ResearchNewMode>('web');
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const capabilities = useResearchNewCapabilities();
  const bases = useResearchNewKnowledgeBases();
  const { create } = useResearchNewMutations();
  const eligibleBases = (bases.data || []).filter((base) => base.publishedDocumentCount > 0);
  const canSubmit = Boolean(question.trim()) && capabilities.data?.model !== false
    && (mode === 'web' || knowledgeBaseIds.length > 0) && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    create.mutate({ question: question.trim(), mode, knowledgeBaseIds: mode === 'hybrid' ? knowledgeBaseIds : [] }, {
      onSuccess: ({ run }) => onCreated(run.id)
    });
  };

  return (
    <Stack>
      <Card>
        <Form onSubmit={submit}>
          <div>
            <h2>新建研究</h2>
            <Row>以可追溯证据为边界，先完成检索和阅读，再生成报告。</Row>
          </div>
          {capabilities.data?.model === false ? <Feedback tone="danger">当前未配置 Qwen 模型，无法启动新版研究。</Feedback> : null}
          {capabilities.data?.webSearch === false ? <Feedback tone="danger">当前未配置联网检索，结果可能只能诚实交付证据不足。</Feedback> : null}
          <Field>
            研究问题
            <textarea value={question} maxLength={4000} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：结合当前项目架构与公开资料，评估 Research 模块还需要哪些改进？" />
          </Field>
          <div>
            <Row as="strong">证据范围</Row>
            <ModeGroup>
              <ModeButton type="button" aria-pressed={mode === 'web'} onClick={() => setMode('web')}>
                <strong>Web</strong><small>仅使用联网来源</small>
              </ModeButton>
              <ModeButton type="button" aria-pressed={mode === 'hybrid'} onClick={() => setMode('hybrid')}>
                <strong>Hybrid</strong><small>项目资料库 + 联网来源</small>
              </ModeButton>
            </ModeGroup>
          </div>
          {mode === 'hybrid' ? (
            <CheckList aria-label="选择资料库">
              {eligibleBases.length ? eligibleBases.map((base) => (
                <label key={base.id}>
                  <input type="checkbox" checked={knowledgeBaseIds.includes(base.id)} onChange={(event) => setKnowledgeBaseIds((current) => event.target.checked ? [...current, base.id] : current.filter((id) => id !== base.id))} />
                  <span>{base.name}<small>{base.publishedDocumentCount} 份已发布文档</small></span>
                </label>
              )) : <Feedback tone="danger">没有可检索的已发布资料，请先在资料库发布文档。</Feedback>}
            </CheckList>
          ) : null}
          {create.error ? <Feedback tone="danger" role="alert">{errorText(create.error)}</Feedback> : null}
          <Button type="submit" variant="primary" disabled={!canSubmit}>{create.isPending ? '正在创建…' : '开始研究'}</Button>
        </Form>
      </Card>
    </Stack>
  );
}

function RunDetail({ run, onBack }: { run: ResearchNewRun; onBack: () => void }) {
  const { cancel } = useResearchNewMutations();
  const active = run.status === 'queued' || run.status === 'running';
  const workspaceSources = run.sources.filter((source) => source.origin === 'workspace').length;
  const webSources = run.sources.filter((source) => source.origin === 'web').length;
  const fullTextReads = run.sources.filter((source) => source.contentLevel === 'full_text').length;
  const snippetReads = run.sources.filter((source) => source.contentLevel === 'snippet').length;
  const sourcesById = new Map(run.sources.map((source) => [source.id, source]));
  const replanTargets = Array.isArray(run.diagnostics.replanTargetTrackIds)
    ? run.diagnostics.replanTargetTrackIds.length : 0;

  return (
    <Pane>
      <PaneHeader
        title={run.question}
        description={`${run.mode === 'hybrid' ? 'Hybrid' : 'Web'} · ${STAGE_LABELS[run.stage] || run.stage}`}
        mobileControls={<><MobileBack size="sm" onClick={onBack}>返回列表</MobileBack><strong>{STATUS_LABELS[run.status]}</strong></>}
        actions={active ? <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>取消研究</Button> : undefined}
      />
      {cancel.error ? <Feedback tone="danger" role="alert">{errorText(cancel.error)}</Feedback> : null}
      <Scroll>
        <Stack>
          <Card>
            <Row><Status $status={run.status}>{STATUS_LABELS[run.status]}</Status><span>{QUALITY_LABELS[run.resultQuality]}</span><span>更新于 {formatTime(run.updatedAt)}</span></Row>
            <Progress max={100} value={run.progress} aria-label="研究进度" />
            <Metrics>
              <div><dt>Track</dt><dd>{run.tracks.filter((track) => track.status === 'answered').length}/{run.tracks.length}</dd></div>
              <div><dt>Web / Workspace 来源</dt><dd>{webSources} / {workspaceSources}</dd></div>
              <div><dt>正文阅读</dt><dd>{fullTextReads}</dd></div>
              <div><dt>Snippet 降级</dt><dd>{snippetReads}</dd></div>
              <div><dt>补充检索</dt><dd>{replanTargets ? `已触发 ${replanTargets} Track` : '未触发'}</dd></div>
              <div><dt>预算</dt><dd>{run.budget.searchCalls}/{run.budget.maxSearchCalls} 次检索</dd></div>
            </Metrics>
          </Card>

          {run.error ? <Feedback tone="danger" role="alert">{run.error}</Feedback> : null}

          {run.tracks.length ? <Card><h2>研究 Track</h2><TrackList>{run.tracks.map((track) => (
            <Track key={track.id}>
              <Row><Status $status={track.status === 'answered' ? 'completed' : undefined}>{track.status || 'pending'}</Status><span>{track.id}</span></Row>
              <h3>{track.question}</h3>
              {track.searchQueries?.length ? <p>查询：{track.searchQueries.join(' · ')}</p> : null}
              {track.gaps?.length ? <ul>{track.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul> : null}
            </Track>
          ))}</TrackList></Card> : null}

          {run.report ? <Card><Report content={run.report} linkPolicy="https-only" /></Card> : active ? <Card><Empty title="研究正在进行" description="界面会自动轮询最新阶段，报告完成后会显示在这里。" icon="↻" /></Card> : null}

          {run.evidence.length ? <Card><h2>来源与引用</h2><Sources>{run.evidence.map((evidence) => {
            const source = sourcesById.get(evidence.sourceId);
            return (
              <li key={evidence.id}>
                <strong>[{evidence.id}] {source?.title || evidence.sourceId}</strong> <Status>{evidence.origin === 'workspace' ? '项目' : 'Web'}</Status>
                {source?.url?.startsWith('https://') ? <p><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a></p> : null}
                <p>{evidence.passage}</p>
                <p>{evidence.contentLevel} · {source?.readerKind || '未知 Reader'}</p>
              </li>
            );
          })}</Sources></Card> : null}

          <Diagnostic><summary>运行诊断</summary><pre>{JSON.stringify({ budget: run.budget, diagnostics: run.diagnostics }, null, 2)}</pre></Diagnostic>
        </Stack>
      </Scroll>
    </Pane>
  );
}

export function ResearchNewWorkspace({ selectedRunId, onSelectRun }: Props) {
  const runs = useResearchNewRuns();
  const selected = useResearchNewRun(selectedRunId);
  const list = useMemo(() => runs.data || [], [runs.data]);
  const mobilePane = selectedRunId ? 'detail' : 'master';

  const master = (
    <Pane>
      <PaneHeader title="研究记录" description="新引擎的独立验证任务" actions={<Button size="sm" variant="primary" onClick={() => onSelectRun('new')}>新建研究</Button>} />
      {runs.error ? <Feedback tone="danger" role="alert" action={<button onClick={() => void runs.refetch()}>重试</button>}>{errorText(runs.error)}</Feedback> : null}
      <Scroll>
        {list.length ? <RunList>{list.map((run) => (
          <RunButton key={run.id} aria-current={selectedRunId === run.id ? 'true' : undefined} onClick={() => onSelectRun(run.id)}>
            <RunQuestion>{run.question}</RunQuestion>
            <Row><Status $status={run.status}>{STATUS_LABELS[run.status]}</Status><span>{run.mode === 'hybrid' ? 'Hybrid' : 'Web'}</span><span>{formatTime(run.updatedAt)}</span></Row>
          </RunButton>
        ))}</RunList> : runs.isLoading ? <Feedback>正在加载研究记录…</Feedback> : <Empty title="还没有新版研究" description="创建一个 Web 或 Hybrid 任务，验证新引擎的检索、阅读与报告闭环。" icon="⌕" />}
      </Scroll>
    </Pane>
  );

  let detail = <Pane><PaneHeader title="新建研究" description="发起一次独立的新引擎任务" mobileControls={<MobileBack size="sm" onClick={() => onSelectRun()}>返回列表</MobileBack>} /><Scroll><NewResearchForm onCreated={onSelectRun} /></Scroll></Pane>;
  if (selectedRunId && selectedRunId !== 'new') {
    detail = selected.data ? <RunDetail run={selected.data} onBack={() => onSelectRun()} />
      : <Pane><PaneHeader title="研究详情" mobileControls={<MobileBack size="sm" onClick={() => onSelectRun()}>返回列表</MobileBack>} /><Scroll>{selected.error ? <Feedback tone="danger" role="alert">{errorText(selected.error)}</Feedback> : <Feedback>正在加载任务…</Feedback>}</Scroll></Pane>;
  }

  return (
    <Shell>
      <FeatureHeader title="新版深度研究" description="与稳定版并行验证的 Evidence-first 研究引擎。" meta={<span>MVP</span>} />
      <MasterDetailLayout master={master} detail={detail} mobilePane={mobilePane} masterLabel="新版研究列表" detailLabel="新版研究详情" />
    </Shell>
  );
}
