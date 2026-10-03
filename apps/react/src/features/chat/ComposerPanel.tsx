import { useState, type FormEvent, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import type { KnowledgeBase } from '@/services/knowledgeApi';
import { Select } from '@/ui/Select';
import type { AgentPreset } from './chat.types';
import { useSpeechRecognition } from './useSpeechRecognition';

type ComposerPanelProps = {
  isActive: boolean;
  statusLabel?: string;
  presets: AgentPreset[];
  presetId: string;
  ragEnabled: boolean;
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseIds: string[];
  controlsDisabled?: boolean;
  onPresetChange: (presetId: string) => void;
  onRagChange: (enabled: boolean) => void;
  onKnowledgeBaseIdsChange: (knowledgeBaseIds: string[]) => void;
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

const PresetSelect = styled(Select)`
  flex: 0 1 12rem;
  min-width: 8rem;
  width: auto;
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

const ScopeControl = styled.details`
  position: relative;

  > summary {
    min-height: 2.25rem;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 0.8125rem;
    list-style: none;
  }

  > summary::-webkit-details-marker { display: none; }
`;

const ScopeMenu = styled.div`
  position: absolute;
  z-index: 5;
  bottom: calc(100% + var(--space-2));
  left: 0;
  display: grid;
  width: min(20rem, calc(100vw - 2rem));
  max-height: 16rem;
  gap: var(--space-2);
  padding: var(--space-3);
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 0.9rem;
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);

  label {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    color: var(--color-text);
    font-size: 0.8125rem;
  }

  small { display: block; color: var(--color-text-subtle); }
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

const VoiceButton = styled.button`
  flex: 0 0 auto;
  min-width: 3.25rem;
  min-height: 3.25rem;
  padding: 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  color: var(--color-text-muted);
  background: var(--color-surface);
  font-size: 1rem;

  &[data-recording='true'] {
    border-color: var(--color-danger-border);
    color: var(--color-danger);
    background: var(--color-danger-surface);
  }

  &:disabled { opacity: 0.45; }
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
  knowledgeBases,
  knowledgeBaseIds,
  controlsDisabled,
  onPresetChange,
  onRagChange,
  onKnowledgeBaseIdsChange,
  onSend,
  onStop
}: ComposerPanelProps) {
  const [draft, setDraft] = useState('');
  const speech = useSpeechRecognition((transcript) => {
    setDraft((current) => `${current}${current.trim() ? ' ' : ''}${transcript}`);
  });

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
        <PresetSelect
          aria-label="角色预设"
          value={presetId}
          disabled={controlsDisabled || isActive}
          onChange={(value) => onPresetChange(value)}
          options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
        />
        <RagControl>
          <input
            type="checkbox"
            checked={ragEnabled}
            disabled={controlsDisabled || isActive}
            onChange={(event) => onRagChange(event.target.checked)}
          />
          使用资料检索
        </RagControl>
        <ScopeControl>
          <summary>资料范围 {knowledgeBaseIds.length}</summary>
          <ScopeMenu>
            {knowledgeBases.length ? knowledgeBases.map((knowledgeBase) => (
              <label key={knowledgeBase.id}>
                <input
                  type="checkbox"
                  checked={knowledgeBaseIds.includes(knowledgeBase.id)}
                  disabled={controlsDisabled || isActive}
                  onChange={(event) => onKnowledgeBaseIdsChange(event.target.checked
                    ? [...knowledgeBaseIds, knowledgeBase.id]
                    : knowledgeBaseIds.filter((id) => id !== knowledgeBase.id))}
                />
                <span>
                  {knowledgeBase.name}
                  <small>{knowledgeBase.publishedDocumentCount} 份可检索</small>
                </span>
              </label>
            )) : <Hint>暂无可用资料库</Hint>}
          </ScopeMenu>
        </ScopeControl>
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
        <VoiceButton
          type="button"
          aria-label={speech.status === 'recording' ? '停止语音输入' : '语音输入'}
          title={speech.supported ? '语音输入只会填入草稿，不会自动发送' : '当前浏览器不支持语音输入'}
          disabled={!speech.supported || isActive}
          data-recording={speech.status === 'recording'}
          onClick={speech.status === 'recording' ? speech.stop : speech.start}
        >
          {speech.status === 'recording' ? '■' : '🎙'}
        </VoiceButton>
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
