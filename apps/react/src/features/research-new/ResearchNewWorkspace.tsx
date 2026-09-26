import { useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
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
import { linkReportEvidence } from './researchNewReport';

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
  pending: '待评估', sufficient: '交付检查通过', limited: '证据有限', insufficient: '证据不足'
};
const VERIFICATION_LABELS: Record<string, string> = {
  citation_integrity: '引用属于本轮证据',
  claim_support: '结论附近有对应引用',
  min_evidence: '达到最低证据数量',
  report_consistency: '报告一致性检查（非逐句核验）',
  required_section: '章节结构检查',
  source_diversity: '多来源或已披露单来源局限',
  source_match: '来源符合研究范围'
};
const TRACK_STATUS_LABELS: Record<string, string> = {
  answered: '已回答', partial: '部分回答', unresolved: '尚未回答', pending: '待处理'
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
const DetailBody = styled.div`
  display: grid;
  gap: var(--space-4);
  width: min(100%, 52rem);
  margin-inline: auto;
`;
const Summary = styled.section`
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  h3 { margin: 0; overflow-wrap: anywhere; font-size: 1.05rem; line-height: 1.5; }
  p { margin: 0; color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.6; }
`;
const Progress = styled.progress`width: 100%; height: 0.5rem; accent-color: var(--color-primary);`;
const TrackList = styled.div`display: grid; gap: var(--space-3); margin-top: var(--space-3);`;
const Track = styled.article`
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--color-surface-muted);
  p { margin-top: 0.35rem; color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.5; }
  ul { margin: 0.5rem 0 0; padding-left: 1.1rem; color: var(--color-danger); font-size: 0.75rem; }
`;
const ReportSection = styled.section`
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
  h3 { margin: 0; font-size: 0.95rem; }
`;
const Report = styled(SafeMarkdown)`
  color: var(--color-text);
  font-size: 0.875rem;
  line-height: 1.75;
  overflow-wrap: anywhere;
  > :first-child { margin-top: 0; }
  p, ul, ol, blockquote { margin: 0.7rem 0; }
  h1, h2, h3, h4 { margin: 1.1rem 0 0.5rem; line-height: 1.35; }
  h1 { font-size: 1.45rem; }
  h2 { font-size: 1.15rem; }
  h3 { font-size: 1rem; }
  a { color: var(--color-primary); overflow-wrap: anywhere; }
  a[href^='#evidence-'] { font-weight: 700; text-decoration: none; }
  code { padding: 0.1em 0.35em; border-radius: 0.35rem; background: var(--color-surface-muted); }
  pre { max-width: 100%; padding: var(--space-3); overflow-x: auto; border-radius: var(--radius-control); background: #182235; color: #e8eef8; }
  pre code { padding: 0; border-radius: 0; background: transparent; color: inherit; }
  table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
  th, td { padding: 0.4rem 0.6rem; border: 1px solid var(--color-border); text-align: left; }
`;
const Disclosure = styled.details`
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  summary { cursor: pointer; color: var(--color-text); font-size: 0.875rem; font-weight: 650; }
  > div { padding-top: var(--space-3); }
`;
const ExecutionDetails = styled.dl`
  display: grid;
  gap: var(--space-2);
  margin: 0;
  div { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: var(--space-2); font-size: 0.8125rem; line-height: 1.6; }
  dt { color: var(--color-text-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
`;
const VerificationList = styled.ul`
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  li { color: var(--color-text-muted); font-size: 0.78rem; line-height: 1.5; }
  li[data-passed='false'] { color: var(--color-danger); }
`;
const Sources = styled.ol`
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  li { min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-control); scroll-margin-top: var(--space-4); }
  li:focus { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  li > strong { display: block; overflow-wrap: anywhere; font-size: 0.8125rem; }
  li > span { color: var(--color-text-muted); font-size: 0.75rem; }
  li details { margin-top: var(--space-1); }
  li summary { color: var(--color-primary); font-size: 0.75rem; }
  li p { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.6; overflow-wrap: anywhere; }
  li a { color: var(--color-primary); }
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

function sourceModeLabel(run: Pick<ResearchNewRun, 'mode' | 'diagnostics'>) {
  if (run.diagnostics.engine === 'sidecar' && run.mode === 'hybrid') {
    if (!run.diagnostics.retrievalBackend) return '预建文档图谱';
    return run.diagnostics.retrievalBackend === 'graphrag' ? '知识库图谱' : '关键词＋向量';
  }
  return run.mode === 'hybrid' ? '项目资料库与网页' : '公开网页';
}

function NewResearchForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<ResearchNewMode>('web');
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [retrievalBackend, setRetrievalBackend] = useState<'workspace' | 'graphrag'>('workspace');
  const capabilities = useResearchNewCapabilities();
  const bases = useResearchNewKnowledgeBases();
  const { create } = useResearchNewMutations();
  const eligibleBases = (bases.data || []).filter((base) => base.publishedDocumentCount > 0);
  const canSubmit = Boolean(question.trim()) && capabilities.data?.model !== false
    && (mode === 'web' || knowledgeBaseIds.length > 0) && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    create.mutate({ question: question.trim(), mode, knowledgeBaseIds: mode === 'hybrid' ? knowledgeBaseIds : [], retrievalBackend }, {
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
                <strong>仅网页</strong><small>只使用公开网页来源</small>
              </ModeButton>
              <ModeButton type="button" aria-pressed={mode === 'hybrid'} onClick={() => setMode('hybrid')}>
                <strong>{capabilities.data?.engine === 'sidecar' ? '项目资料' : '项目资料 + 网页'}</strong>
                <small>{capabilities.data?.engine === 'sidecar' ? '使用所选知识库' : '结合项目资料与联网来源'}</small>
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
          {mode === 'hybrid' && capabilities.data?.engine === 'sidecar' ? (
            <>
              <ModeGroup aria-label="资料检索方式">
                <ModeButton type="button" aria-pressed={retrievalBackend === 'workspace'} onClick={() => setRetrievalBackend('workspace')}>
                  <strong>关键词＋向量</strong><small>使用现有知识库索引</small>
                </ModeButton>
                <ModeButton type="button" aria-pressed={retrievalBackend === 'graphrag'} onClick={() => setRetrievalBackend('graphrag')}>
                  <strong>GraphRAG</strong><small>仅支持已建图的单个资料库</small>
                </ModeButton>
              </ModeGroup>
              <Feedback>两种方式使用同一 Sidecar 研究流程；当前不混合网页来源。图谱在文档变更后需手动重建。</Feedback>
            </>
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
  const sourcesDisclosure = useRef<HTMLDetailsElement>(null);
  const active = run.status === 'queued' || run.status === 'running';
  const webSources = run.sources.filter((source) => source.origin === 'web').length;
  const workspaceDocuments = new Set(run.sources.filter((source) => source.origin === 'workspace').map((source) => source.documentId || source.title || source.id)).size;
  const sourcesById = new Map(run.sources.map((source) => [source.id, source]));
  const { content: linkedReport, citedIds } = linkReportEvidence(run.report, run.evidence.map((item) => item.id));
  const citedNumbers = new Map(citedIds.map((id, index) => [id, index + 1]));
  const evidenceById = new Map(run.evidence.map((item) => [item.id, item]));
  const orderedEvidence = [
    ...citedIds.map((id) => evidenceById.get(id)!),
    ...run.evidence.filter((item) => !citedNumbers.has(item.id))
  ];
  const sidecar = run.diagnostics.sidecar as {
    corpus?: string;
    evidenceTrace?: { evidenceId: string; position?: number | null }[];
    verification?: { kind: string; passed: boolean; required?: boolean }[];
  } | undefined;
  const positions = new Map(sidecar?.evidenceTrace?.map((item) => [item.evidenceId, item.position]) || []);
  const requiredChecks = sidecar?.verification?.filter((item) => item.required) || [];
  const scope = sidecar?.corpus === 'prebuilt_sidecar_graph'
    ? `预建图谱 · ${workspaceDocuments} 份项目文档、${run.evidence.length} 条证据；所选资料库尚未同步`
    : run.status === 'completed'
      ? run.mode === 'web'
        ? `公开网页 · ${webSources} 个来源、${run.evidence.length} 条证据`
        : `${sourceModeLabel(run)} · ${workspaceDocuments} 份项目文档、${webSources} 个网页来源、${run.evidence.length} 条证据`
      : sourceModeLabel(run);

  function openEvidence(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#evidence-"]');
    if (!link) return;
    const id = link.getAttribute('href')?.slice('#evidence-'.length);
    if (!id || !evidenceById.has(id)) return;
    event.preventDefault();
    if (sourcesDisclosure.current) sourcesDisclosure.current.open = true;
    requestAnimationFrame(() => {
      const item = document.getElementById(`evidence-${id}`);
      item?.scrollIntoView({ block: 'center' });
      item?.focus({ preventScroll: true });
    });
  }

  return (
    <Pane>
      <PaneHeader
        title="研究详情"
        description={active ? STAGE_LABELS[run.stage] || run.stage : undefined}
        mobileControls={<MobileBack size="sm" onClick={onBack}>返回列表</MobileBack>}
        actions={active ? <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>取消研究</Button> : undefined}
      />
      {cancel.error ? <Feedback tone="danger" role="alert">{errorText(cancel.error)}</Feedback> : null}
      <Scroll>
        <DetailBody>
          <Summary>
            <h3>{run.question}</h3>
            <Row><Status $status={run.status}>{STATUS_LABELS[run.status]}</Status><span>{QUALITY_LABELS[run.resultQuality]}</span><span>更新于 {formatTime(run.updatedAt)}</span></Row>
            <p>资料范围：{scope}</p>
            {active ? <Progress max={100} value={run.progress} aria-label="研究进度" /> : null}
          </Summary>

          {run.error ? <Feedback tone="danger" role="alert">{run.error}</Feedback> : null}

          {run.report ? (
            <ReportSection aria-labelledby="research-new-report-title">
              <h3 id="research-new-report-title">最终报告</h3>
              <p>交付检查不等于事实核验；本报告未进行逐句语义核验，请结合引用原文判断结论。</p>
              <div onClick={openEvidence}><Report content={linkedReport} linkPolicy="https-and-evidence" /></div>
            </ReportSection>
          ) : active ? <Empty title="研究正在进行" description="界面会自动更新阶段，报告完成后显示在这里。" icon="↻" /> : null}

          {run.evidence.length ? <Disclosure ref={sourcesDisclosure}><summary>引用来源（{run.evidence.length} 条）</summary><div><Sources>{orderedEvidence.map((evidence) => {
            const source = sourcesById.get(evidence.sourceId);
            const number = citedNumbers.get(evidence.id);
            const position = positions.get(evidence.id);
            return (
              <li key={evidence.id} id={`evidence-${evidence.id}`} tabIndex={-1}>
                <strong>{number ? `[${number}] ` : '补充材料 · '}{source?.title || '未命名来源'}</strong>
                <span>{evidence.origin === 'workspace' ? '项目文档' : '网页来源'}{typeof position === 'number' ? ` · 第 ${position} 段` : ''}</span>
                <details><summary>查看支持内容</summary><p>{evidence.passage}</p></details>
                {source?.url?.startsWith('https://') ? <p><a href={source.url} target="_blank" rel="noopener noreferrer">打开网页来源</a></p> : null}
              </li>
            );
          })}</Sources></div></Disclosure> : null}

          <Disclosure><summary>执行详情</summary><div>
            <ExecutionDetails>
              <div><dt>当前阶段</dt><dd>{STAGE_LABELS[run.stage] || run.stage}</dd></div>
              <div><dt>工具调用</dt><dd>{sidecar && run.budget.searchCalls === 0 ? '历史任务未记录' : `${run.budget.searchCalls} 次`}</dd></div>
              {requiredChecks.length ? <div><dt>报告检查</dt><dd>{requiredChecks.filter((item) => item.passed).length}/{requiredChecks.length} 项通过</dd></div> : null}
            </ExecutionDetails>
            {requiredChecks.length ? <VerificationList>{requiredChecks.map((check) => (
              <li key={check.kind} data-passed={check.passed}>{check.passed ? '通过' : '未通过'} · {VERIFICATION_LABELS[check.kind] || check.kind}</li>
            ))}</VerificationList> : null}
            {run.tracks.length ? <><h3>研究问题</h3><TrackList>{run.tracks.map((track) => (
              <Track key={track.id}><h3>{track.question}</h3><p>{TRACK_STATUS_LABELS[track.status || 'pending'] || track.status}</p></Track>
            ))}</TrackList></> : null}
          </div></Disclosure>
        </DetailBody>
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
            <Row><Status $status={run.status}>{STATUS_LABELS[run.status]}</Status><span>{sourceModeLabel(run)}</span><span>{formatTime(run.updatedAt)}</span></Row>
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
      <FeatureHeader title="新版深度研究" description="以资料证据为依据生成报告，与现有版本并行验证。" meta={<span>试用</span>} />
      <MasterDetailLayout master={master} detail={detail} mobilePane={mobilePane} masterLabel="新版研究列表" detailLabel="新版研究详情" />
    </Shell>
  );
}
