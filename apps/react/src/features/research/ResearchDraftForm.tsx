import styled from 'styled-components';
import type { KnowledgeBase } from '@/services/knowledgeApi';
import type { ResearchSearchMode } from '@/services/researchApi';
import { researchSearchModeLabel } from './researchPresentation';

type ResearchDraftFormProps = {
  question: string;
  onQuestionChange: (value: string) => void;
  knowledgeBases: KnowledgeBase[];
  knowledgeBasesLoading: boolean;
  knowledgeBasesError: string | null;
  onRetryKnowledgeBases: () => void;
  selectedKnowledgeBaseIds: string[];
  onToggleKnowledgeBase: (id: string) => void;
  externalSearch: boolean;
  onExternalSearchChange: (value: boolean) => void;
  /** capability 未就绪或不可用时开关禁用。 */
  externalSearchLocked: boolean;
  /** capability 请求是否已完成（区分加载中与确实未配置）。 */
  externalSearchReady: boolean;
  /** capability 刷新失败（与未配置区分提示）。 */
  externalSearchFailed: boolean;
  externalSearchAvailable: boolean;
  /** 由调用方按同一套门控计算出的最终 searchMode；null 表示当前组合禁止提交。 */
  searchMode: ResearchSearchMode | null;
  submitting: boolean;
  error?: string;
  sourceHint?: string;
  submitLabel: string;
  onSubmit: () => void;
  busy?: boolean;
  busyHint?: string;
};

const Form = styled.form`
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5) var(--space-6);

  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }

  textarea {
    width: 100%;
    min-height: 7rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    line-height: 1.55;
    resize: vertical;
  }

  .field-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }

  .knowledge-list { display: grid; gap: var(--space-2); }
  .knowledge-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .knowledge-option:hover { background: var(--color-primary-surface); }
  .knowledge-option input { flex: 0 0 auto; }
  .knowledge-option .knowledge-name { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
  .knowledge-option .knowledge-meta { flex: 0 0 auto; color: var(--color-text-muted); font-size: 0.72rem; }
  .knowledge-option .knowledge-meta.is-empty { color: var(--color-text-subtle); }

  .switch-line { display: flex; align-items: center; gap: var(--space-2); color: var(--color-text); font-size: 0.875rem; }
  .switch-hint { margin: 0; color: var(--color-text-muted); font-size: 0.75rem; }
  .switch-hint.is-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    color: var(--color-danger);
    background: var(--color-danger-surface);
  }
  .switch-hint.is-error button {
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-control);
    color: var(--color-danger);
    background: var(--color-surface);
    font-size: 0.72rem;
  }

  .mode-summary { margin: 0; color: var(--color-text-muted); font-size: 0.75rem; }
  .mode-summary.is-invalid { color: var(--color-danger); }

  .submit-row { display: flex; justify-content: flex-start; }
`;

const Hint = styled.p`
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  color: var(--color-text-muted);
  background: var(--color-primary-surface);
  font-size: 0.75rem;
`;

const ErrorAlert = styled.p`
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-control);
  color: var(--color-danger);
  background: var(--color-danger-surface);
  font-size: 0.8125rem;
`;

const SubmitButton = styled.button`
  min-height: 2.5rem;
  padding: 0.55rem 1rem;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-control);
  color: white;
  background: var(--color-primary);
  font-size: 0.875rem;
  font-weight: 650;

  &:disabled { cursor: not-allowed; opacity: 0.55; }
`;

export function ResearchDraftForm({
  question,
  onQuestionChange,
  knowledgeBases,
  knowledgeBasesLoading,
  knowledgeBasesError,
  onRetryKnowledgeBases,
  selectedKnowledgeBaseIds,
  onToggleKnowledgeBase,
  externalSearch,
  onExternalSearchChange,
  externalSearchLocked,
  externalSearchReady,
  externalSearchFailed,
  externalSearchAvailable,
  searchMode,
  submitting,
  error,
  sourceHint,
  submitLabel,
  onSubmit,
  busy,
  busyHint
}: ResearchDraftFormProps) {
  return (
    <Form
      aria-label="研究草稿"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {sourceHint ? <Hint>{sourceHint}</Hint> : null}
      <label>
        <span className="field-head">
          研究问题
          <span>{question.length}/4000</span>
        </span>
        <textarea
          value={question}
          maxLength={4000}
          rows={5}
          aria-label="研究问题"
          placeholder="输入需要深入研究的问题"
          onChange={(event) => onQuestionChange(event.target.value)}
        />
      </label>

      <div>
        <span className="field-head">
          <span>资料库范围</span>
        </span>
        <div className="knowledge-list">
          {knowledgeBases.map((base) => {
            const retrievable = base.publishedDocumentCount > 0;
            return (
              <label key={base.id} className="knowledge-option">
                <input
                  type="checkbox"
                  checked={selectedKnowledgeBaseIds.includes(base.id)}
                  onChange={() => onToggleKnowledgeBase(base.id)}
                  aria-label={`选择资料库 ${base.name}`}
                />
                <span className="knowledge-name">{base.name}</span>
                <span className={`knowledge-meta${retrievable ? '' : ' is-empty'}`}>
                  {retrievable ? `可检索 ${base.publishedDocumentCount}` : '暂无可检索文档'}
                </span>
              </label>
            );
          })}
          {!knowledgeBases.length && knowledgeBasesError ? (
            <p className="switch-hint is-error" role="alert">
              加载资料库失败：{knowledgeBasesError}
              <button type="button" onClick={onRetryKnowledgeBases}>重试</button>
            </p>
          ) : null}
          {!knowledgeBases.length && knowledgeBasesLoading ? (
            <p className="switch-hint">正在加载资料库…</p>
          ) : null}
          {!knowledgeBases.length && !knowledgeBasesLoading && !knowledgeBasesError ? (
            <p className="switch-hint">当前工作区还没有可用的资料库。</p>
          ) : null}
        </div>
      </div>

      <div>
        <label className="switch-line">
          <input
            type="checkbox"
            checked={externalSearch && externalSearchAvailable}
            disabled={externalSearchLocked}
            onChange={(event) => onExternalSearchChange(event.target.checked)}
            aria-label="使用外部检索补充验证"
          />
          使用外部检索补充验证
        </label>
        <p className="switch-hint">
          {externalSearchFailed
            ? '暂时无法确认外部检索能力，已停用外部检索。'
            : !externalSearchReady
              ? '正在确认部署的检索能力，外部检索暂时不可用。'
              : externalSearchAvailable
                ? '以项目资料为主，外部公开资料只用于补充与交叉核对。'
                : '当前部署未配置外部检索；仅可使用有可检索文档的内部资料。'}
        </p>
      </div>

      <p className={`mode-summary${searchMode ? '' : ' is-invalid'}`}>
        {searchMode
          ? `提交后将使用：${researchSearchModeLabel(searchMode)}`
          : '当前组合无法提交：请选择有可检索文档的资料库，或在能力可用时开启外部检索。'}
      </p>

      {error ? <ErrorAlert role="alert">{error}</ErrorAlert> : null}
      {busy && busyHint ? <Hint>{busyHint}</Hint> : null}

      <div className="submit-row">
        <SubmitButton type="submit" disabled={submitting || busy || !searchMode}>
          {submitting ? '正在创建研究…' : submitLabel}
        </SubmitButton>
      </div>
    </Form>
  );
}
