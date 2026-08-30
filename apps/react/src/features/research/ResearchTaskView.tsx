import styled from 'styled-components';
import type { ResearchCitation, ResearchTask } from '@/services/researchApi';
import {
  RESEARCH_STAGES,
  clampResearchProgress,
  formatResearchTime,
  plannerLabel,
  researchDiagnosticReasonLabel,
  researchIntentLabel,
  researchQualityLabel,
  researchSearchModeLabel,
  researchSourceKindLabel,
  researchSourceTypeLabel,
  researchStageLabel,
  researchStageState,
  researchStatusLabel,
  researchWebStatusLabel,
  safeResearchExternalUrl
} from './researchPresentation';
import { ResearchReport } from './ResearchReport';

type ResearchTaskViewProps = {
  task: ResearchTask;
  runs: ResearchTask[];
  pollStale: boolean;
  onSelectRun: (taskId: string) => void;
};

const Body = styled.div`
  display: grid;
  gap: var(--space-4);
  align-content: start;
  padding: var(--space-4) var(--space-5) var(--space-6);
`;

const Question = styled.h2`
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
`;

const ProgressCopy = styled.div`
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: 0.8rem;
`;

const ProgressTrack = styled.div`
  overflow: hidden;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--color-surface-muted);

  > span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary); }
`;

const StageList = styled.ol`
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;

  li { display: grid; gap: var(--space-1); color: var(--color-text-muted); font-size: 0.68rem; text-align: center; }
  li > span { height: 0.375rem; border-radius: 999px; background: var(--color-surface-muted); }
  li[data-state='done'] > span, li[data-state='current'] > span { background: var(--color-primary); }
  li[data-state='current'] strong { color: var(--color-primary); }
  li[data-state='failed'] > span { background: var(--color-danger); }
  li[data-state='failed'] strong { color: var(--color-danger); }

  @media (max-width: 48rem) { grid-template-columns: 1fr; li { grid-template-columns: 1rem 1fr; align-items: center; text-align: left; } }
`;

const MetaGrid = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: var(--space-2);
  margin: 0;

  div { min-width: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); background: var(--color-background); }
  dt { color: var(--color-text-muted); font-size: 0.7rem; }
  dd { margin: 0.2rem 0 0; overflow-wrap: anywhere; font-size: 0.8125rem; }
`;

const RunTimeline = styled.section`
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);

  h3 { margin: 0; font-size: 0.85rem; }
  > p { margin: 0; color: var(--color-text-muted); font-size: 0.72rem; }
  > div { display: grid; gap: var(--space-1); }
`;

const RunButton = styled.button`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  text-align: left;
  cursor: pointer;

  &[aria-current='true'] { border-color: var(--color-primary-border); background: var(--color-primary-surface); }
  strong { font-size: 0.78rem; white-space: nowrap; }
  span { min-width: 0; overflow: hidden; color: var(--color-text-muted); font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
  em { flex: 0 0 auto; color: var(--color-text-muted); font-size: 0.7rem; font-style: normal; }
`;

const QualitySection = styled.section`
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-background);

  strong { font-size: 0.85rem; }
  &[data-quality='insufficient'] { border-color: var(--color-danger-border); background: var(--color-danger-surface); }
  &[data-quality='insufficient'] strong { color: var(--color-danger); }

  p { margin: 0; color: var(--color-text-muted); font-size: 0.8rem; }
  ul { margin: 0; padding-left: 1.1rem; color: var(--color-text-muted); font-size: 0.8rem; line-height: 1.6; }
`;

const Alert = styled.section<{ $tone: 'danger' | 'info' }>`
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-control);
  background: ${({ $tone }) => ($tone === 'danger' ? 'var(--color-danger-surface)' : 'var(--color-primary-surface)')};
  color: ${({ $tone }) => ($tone === 'danger' ? 'var(--color-danger)' : 'var(--color-text)')};

  strong { font-size: 0.85rem; }
  p { margin: 0; font-size: 0.8rem; overflow-wrap: anywhere; }
`;

const Collapsible = styled.details`
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);

  summary { color: var(--color-text); font-size: 0.85rem; font-weight: 650; cursor: pointer; }
  > div { display: grid; gap: var(--space-3); padding-top: var(--space-3); }
`;

const PlanList = styled.ol`
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding-left: 1.2rem;
  color: var(--color-text);
  font-size: 0.8125rem;

  li { line-height: 1.6; overflow-wrap: anywhere; }
  .plan-intent { color: var(--color-text-muted); font-size: 0.75rem; }
`;

const EvidenceItem = styled.li`
  display: grid;
  gap: 0.2rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-background);

  .evidence-claim { overflow-wrap: anywhere; font-size: 0.8125rem; }
  .evidence-snippet { color: var(--color-text-muted); font-size: 0.75rem; line-height: 1.55; overflow-wrap: anywhere; }
  .evidence-source { color: var(--color-text-muted); font-size: 0.72rem; overflow-wrap: anywhere; }
  .evidence-source a { color: var(--color-primary); }
`;

const DiagnosticsList = styled.dl`
  display: grid;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.78rem;

  div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: var(--space-2); }
  dt { color: var(--color-text-subtle); }
  dd { margin: 0; overflow-wrap: anywhere; color: var(--color-text); }
`;

function citationById(citations: ResearchCitation[], id: string) {
  return citations.find((citation) => citation.id === id);
}

export function ResearchTaskView({
  task,
  runs,
  pollStale,
  onSelectRun
}: ResearchTaskViewProps) {
  const completed = task.status === 'completed';
  const active = task.status === 'queued' || task.status === 'running';
  const artifacts = task.artifacts || {};
  const plan = artifacts.plan;
  const evidencePack = artifacts.evidencePack;
  const diagnostics = artifacts.diagnostics || {
    planning: artifacts.plan?.diagnostics || null,
    retrieval: [],
    reading: artifacts.reading || null,
    writing: artifacts.writer || null
  };

  return (
    <Body>
      <Question>{task.question}</Question>

      {!completed ? (
        <>
          <ProgressCopy>
            <span>{researchStageLabel(task.stage)}</span>
            <span>{clampResearchProgress(task.progress)}%</span>
          </ProgressCopy>
          <ProgressTrack
            role="progressbar"
            aria-label="研究进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={clampResearchProgress(task.progress)}
          >
            <span style={{ width: `${clampResearchProgress(task.progress)}%` }} />
          </ProgressTrack>
          <StageList aria-label="研究阶段进度">
            {RESEARCH_STAGES.map((stage) => (
              <li key={stage.id} data-state={researchStageState(task, stage.id)}>
                <span aria-hidden="true" />
                <strong>{stage.label}</strong>
              </li>
            ))}
          </StageList>
        </>
      ) : null}

      {active && pollStale ? (
        <Alert $tone="info"><p>暂时无法获取最新进度，仍在显示最近一次成功快照。</p></Alert>
      ) : null}

      <MetaGrid>
        <div><dt>资料模式</dt><dd>{researchSearchModeLabel(task.searchMode)}</dd></div>
        <div><dt>外部检索</dt><dd>{researchWebStatusLabel(task.webSearchStatus)}</dd></div>
        <div><dt>结果质量</dt><dd>{researchQualityLabel(task.resultQuality)}</dd></div>
        <div><dt>执行次数</dt><dd>第 {Math.max(1, task.attempt || 1)} 次</dd></div>
        <div><dt>最后更新</dt><dd>{formatResearchTime(task.updatedAt)}</dd></div>
      </MetaGrid>

      {runs.length > 1 ? (
        <RunTimeline aria-label="研究轮次">
          <h3>研究轮次</h3>
          <p>同一会话内的历次研究，点击切换阅读。</p>
          <div>
            {runs.map((run) => (
              <RunButton
                key={run.id}
                type="button"
                aria-current={run.id === task.id}
                onClick={() => onSelectRun(run.id)}
              >
                <strong>第 {run.turnIndex} 轮</strong>
                <span>{run.question}</span>
                <em>{researchStatusLabel(run.status)}</em>
              </RunButton>
            ))}
          </div>
        </RunTimeline>
      ) : null}

      {task.status === 'failed' ? (
        <Alert $tone="danger" role="alert">
          <strong>{task.failedStage ? `失败步骤：${researchStageLabel(task.failedStage)}` : '任务执行失败'}</strong>
          <p>{task.error || '任务执行失败，可稍后重试。'}</p>
        </Alert>
      ) : null}
      {task.status === 'cancelled' ? (
        <Alert $tone="info">
          <strong>任务已取消</strong>
          <p>执行已停止；已生成的计划和证据继续保留，可以基于原输入重新研究。</p>
        </Alert>
      ) : null}

      {completed ? (
        <QualitySection data-quality={task.resultQuality}>
          <strong>证据质量：{researchQualityLabel(task.resultQuality)}</strong>
          {task.limitations.length ? (
            <>
              <p>以下局限来自证据评估，阅读结论时请一并考虑：</p>
              <ul>
                {task.limitations.map((limitation) => (
                  <li key={limitation.code}>{limitation.message}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>质量评估未发现需要特别提示的局限；报告结论仍请结合引用自行核对。</p>
          )}
        </QualitySection>
      ) : null}

      {completed && task.report ? <ResearchReport report={task.report} /> : null}
      {completed && !task.report ? (
        <Alert $tone="info"><p>任务已完成，但本次执行没有生成报告正文。</p></Alert>
      ) : null}

      {plan ? (
        <Collapsible>
          <summary>研究计划</summary>
          <div>
            <p className="plan-intent">
              规划方式：{plannerLabel(plan.planner)}
              {plan.objective ? ` · 目标：${plan.objective}` : ''}
            </p>
            <PlanList>
              {(plan.subquestions || []).map((item) => (
                <li key={item.id}>
                  <span>{item.question}</span>
                  <div className="plan-intent">
                    {researchIntentLabel(item.intent)}
                    {item.rationale ? ` · ${item.rationale}` : ''}
                    {item.evidenceNeed?.preferredSourceTypes?.length
                      ? ` · 偏好来源：${item.evidenceNeed.preferredSourceTypes.map(researchSourceTypeLabel).join('、')}`
                      : ''}
                  </div>
                  {item.searchQuery ? <div className="plan-intent">检索词：{item.searchQuery}</div> : null}
                </li>
              ))}
            </PlanList>
            {plan.planner === 'fallback' ? (
              <p className="plan-intent">{plan.fallbackReason || '规划结果未通过校验，已围绕原始问题安全降级。'}</p>
            ) : null}
          </div>
        </Collapsible>
      ) : null}

      {evidencePack || task.citations.length ? (
        <Collapsible>
          <summary>证据过程与引用来源</summary>
          <div>
            {evidencePack ? (
              <p className="plan-intent">
                候选来源 {evidencePack.candidateCount ?? 0} · 通过筛选 {evidencePack.acceptedCount ?? 0} ·
                已读取 {evidencePack.readSourceCount ?? 0} · 证据片段 {evidencePack.passageCount ?? evidencePack.includedCount ?? 0} ·
                报告引用 {evidencePack.citationCount ?? task.citations.length}
                {typeof evidencePack.totalCharacters === 'number' ? ` · 共 ${evidencePack.totalCharacters} 字符` : ''}
                {evidencePack.snippetFallbackCount ? ` · ${evidencePack.snippetFallbackCount} 段使用搜索摘要` : ''}
              </p>
            ) : null}
            <ul style={{ display: 'grid', gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none' }}>
              {(artifacts.evidence || []).map((item, index) => {
                const citation = citationById(task.citations, item.citationId);
                const link = safeResearchExternalUrl(citation?.url);
                return (
                  <EvidenceItem key={`${item.citationId}-${index}`}>
                    <span className="evidence-claim">
                      {item.citationNumber ? `[${item.citationNumber}] ` : ''}{item.claim}
                    </span>
                    <span className="evidence-snippet">{item.snippet || citation?.snippet}</span>
                    <span className="evidence-source">
                      {citation ? `${researchSourceKindLabel(citation.kind)} · ${citation.title || citation.source}` : '来源详情缺失'}
                      {link ? <> · <a href={link} target="_blank" rel="noopener noreferrer">打开来源</a></> : null}
                    </span>
                  </EvidenceItem>
                );
              })}
              {!artifacts.evidence?.length && task.citations.map((citation) => {
                const link = safeResearchExternalUrl(citation.url);
                return (
                  <EvidenceItem key={citation.id}>
                    <span className="evidence-claim">{citation.title || '未命名来源'}</span>
                    {citation.snippet ? <span className="evidence-snippet">{citation.snippet}</span> : null}
                    <span className="evidence-source">
                      {researchSourceKindLabel(citation.kind)} · {citation.source}
                      {link ? <> · <a href={link} target="_blank" rel="noopener noreferrer">打开来源</a></> : null}
                    </span>
                  </EvidenceItem>
                );
              })}
            </ul>
            {evidencePack?.excludedCount ? (
              <p className="plan-intent">另有 {evidencePack.excludedCount} 条候选来源因相关性或资料配额未进入报告。</p>
            ) : null}
            <p className="plan-intent">引用编号可追溯到来源内容，不代表结论已被事实核验。</p>
          </div>
        </Collapsible>
      ) : null}

      {diagnostics ? (
        <Collapsible>
          <summary>执行详情</summary>
          <div>
            <DiagnosticsList>
              {diagnostics.planning ? (
                <div>
                  <dt>规划</dt>
                  <dd>
                    {diagnostics.planning.mode || '—'} · {diagnostics.planning.status || '—'}
                    {researchDiagnosticReasonLabel(diagnostics.planning.reasonCode)
                      ? ` · ${researchDiagnosticReasonLabel(diagnostics.planning.reasonCode)}`
                      : ''}
                  </dd>
                </div>
              ) : null}
              {diagnostics.retrieval?.length ? (
                <div>
                  <dt>检索</dt>
                  <dd>
                    {diagnostics.retrieval.map((item) => `${item.query}（${item.sourceCount} 条 · ${item.status}）`).join('；')}
                  </dd>
                </div>
              ) : null}
              {diagnostics.reading ? (
                <div>
                  <dt>精读</dt>
                  <dd>
                    选中 {diagnostics.reading.selectedSourceCount ?? 0} · 读取 {diagnostics.reading.readSourceCount ?? 0} ·
                    失败 {diagnostics.reading.failedSourceCount ?? 0}
                  </dd>
                </div>
              ) : null}
              {diagnostics.writing ? (
                <div>
                  <dt>写作</dt>
                  <dd>
                    {diagnostics.writing.mode || '—'} · {diagnostics.writing.status || '—'}
                    {researchDiagnosticReasonLabel(diagnostics.writing.reasonCode)
                      ? ` · ${researchDiagnosticReasonLabel(diagnostics.writing.reasonCode)}`
                      : ''}
                    {typeof diagnostics.writing.outputCharacters === 'number' ? ` · ${diagnostics.writing.outputCharacters} 字符` : ''}
                  </dd>
                </div>
              ) : null}
            </DiagnosticsList>
          </div>
        </Collapsible>
      ) : null}

    </Body>
  );
}
