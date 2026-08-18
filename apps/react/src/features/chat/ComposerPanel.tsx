import { useState, type FormEvent, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import type { AgentPreset } from './chat.types';

type ComposerPanelProps = {
  isActive: boolean;
  statusLabel?: string;
  presets: AgentPreset[];
  presetId: string;
  ragEnabled: boolean;
  controlsDisabled?: boolean;
  onPresetChange: (presetId: string) => void;
  onRagChange: (enabled: boolean) => void;
  onSend: (content: string) => Promise<boolean>;
  onStop: () => void;
};

const Composer = styled.form`
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5) var(--space-5);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
`;

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
`;

const Select = styled.select`
  min-height: 2.25rem;
  max-width: 12rem;
  padding: 0.35rem 2rem 0.35rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  color: var(--color-text);
  background: var(--color-surface);
  font-size: 0.8125rem;
`;

const RagControl = styled.label`
  display: inline-flex;
  min-height: 2.25rem;
  align-items: center;
  gap: var(--space-2);
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
`;

const InputRow = styled.div`
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
`;

const Textarea = styled.textarea`
  width: 100%;
  min-height: 3.25rem;
  max-height: 11rem;
  padding: 0.85rem 1rem;
  resize: vertical;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  color: var(--color-text);
  background: var(--color-background);
  line-height: 1.5;

  &:focus {
    border-color: var(--color-primary-border);
    background: var(--color-surface);
  }
`;

const ActionButton = styled.button`
  flex: 0 0 auto;
  min-width: 6rem;
  min-height: 3.25rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--color-primary);
  border-radius: 1rem;
  color: white;
  background: var(--color-primary);
  font-weight: 750;

  &[data-stop='true'] {
    border-color: var(--color-danger-border);
    color: var(--color-danger);
    background: var(--color-danger-surface);
  }

  &:disabled {
    opacity: 0.55;
  }

  @media (max-width: 40rem) {
    min-width: 4.5rem;
  }
`;

const Hint = styled.p`
  margin: 0;
  color: var(--color-text-subtle);
  font-size: 0.75rem;
`;

export function ComposerPanel({
  isActive,
  statusLabel,
  presets,
  presetId,
  ragEnabled,
  controlsDisabled,
  onPresetChange,
  onRagChange,
  onSend,
  onStop
}: ComposerPanelProps) {
  const [draft, setDraft] = useState('');

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || isActive) return;
    const started = await onSend(content);
    if (started) setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <Composer onSubmit={submit}>
      <Controls>
        <Select
          aria-label="角色预设"
          value={presetId}
          disabled={controlsDisabled || isActive}
          onChange={(event) => onPresetChange(event.target.value)}
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.name}</option>
          ))}
        </Select>
        <RagControl>
          <input
            type="checkbox"
            checked={ragEnabled}
            disabled={controlsDisabled || isActive}
            onChange={(event) => onRagChange(event.target.checked)}
          />
          使用资料检索
        </RagControl>
        {isActive && statusLabel ? <Hint role="status">{statusLabel}</Hint> : null}
      </Controls>
      <InputRow>
        <Textarea
          aria-label="输入消息"
          value={draft}
          disabled={false}
          placeholder="输入问题；Enter 发送，Shift + Enter 换行"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {isActive ? (
          <ActionButton type="button" data-stop="true" aria-label="停止生成" onClick={onStop}>
            停止
          </ActionButton>
        ) : (
          <ActionButton type="submit" aria-label="发送消息" disabled={!draft.trim()}>
            发送
          </ActionButton>
        )}
      </InputRow>
      <Hint>AI 可能会犯错；重要信息请结合引用和 Agent Run 复核。</Hint>
    </Composer>
  );
}
