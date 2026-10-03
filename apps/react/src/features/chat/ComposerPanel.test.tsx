import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerPanel } from './ComposerPanel';

const baseProps = {
  isActive: false,
  presets: [{ id: 'general', name: '通用助手', description: '', defaultKnowledgeBaseIds: [] }],
  presetId: 'general',
  ragEnabled: true,
  knowledgeBases: [
    { id: 'kb-default', name: '默认知识库', isDefault: true, documentCount: 2, publishedDocumentCount: 2, draftDocumentCount: 0, createdAt: 1, updatedAt: 1 },
    { id: 'kb-project', name: '项目资料', isDefault: false, documentCount: 3, publishedDocumentCount: 1, draftDocumentCount: 2, createdAt: 2, updatedAt: 2 }
  ],
  knowledgeBaseIds: ['kb-default'],
  onPresetChange: vi.fn(),
  onRagChange: vi.fn(),
  onKnowledgeBaseIdsChange: vi.fn(),
  onSend: vi.fn(async () => true),
  onStop: vi.fn()
};

afterEach(() => {
  vi.restoreAllMocks();
  delete window.webkitSpeechRecognition;
});

describe('ComposerPanel', () => {
  it('clears the accepted draft before generation finishes and preserves the next draft', async () => {
    let accept: (() => void) | undefined;
    let finish: ((started: boolean) => void) | undefined;
    const onSend = vi.fn((_content: string, onAccepted?: () => void) => {
      accept = onAccepted;
      return new Promise<boolean>((resolve) => { finish = resolve; });
    });
    render(<ComposerPanel {...baseProps} onSend={onSend} />);
    const input = screen.getByRole('textbox', { name: '输入消息' });
    await userEvent.type(input, '当前问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(input).toHaveValue('当前问题');
    act(() => accept?.());
    expect(input).toHaveValue('');
    await userEvent.type(input, '下一条草稿');
    await act(async () => finish?.(true));
    expect(input).toHaveValue('下一条草稿');
  });

  it('keeps the draft when sending fails before acceptance', async () => {
    render(<ComposerPanel {...baseProps} onSend={async () => false} />);
    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '未发送的问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('未发送的问题');
  });

  it('lets the user choose the retrieval scope', async () => {
    const onKnowledgeBaseIdsChange = vi.fn();
    render(<ComposerPanel {...baseProps} onKnowledgeBaseIdsChange={onKnowledgeBaseIdsChange} />);

    await userEvent.click(screen.getByText('资料范围 1'));
    await userEvent.click(screen.getByRole('checkbox', { name: /项目资料/ }));

    expect(onKnowledgeBaseIdsChange).toHaveBeenCalledWith(['kb-default', 'kb-project']);
  });

  it('adds recognized speech to the draft without sending it', async () => {
    let recognition: FakeRecognition | undefined;
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
      onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() { recognition = this; }
    }
    window.webkitSpeechRecognition = FakeRecognition as unknown as typeof window.webkitSpeechRecognition;
    const onSend = vi.fn(async () => true);
    render(<ComposerPanel {...baseProps} onSend={onSend} />);

    await userEvent.click(screen.getByRole('button', { name: '语音输入' }));
    await act(async () => {
      recognition?.onresult?.({
        results: { 0: { 0: { transcript: '帮我检查错误' }, isFinal: true, length: 1 }, length: 1 }
      } as unknown as SpeechRecognitionEvent);
    });

    expect(screen.getByRole('textbox', { name: '输入消息' })).toHaveValue('帮我检查错误');
    expect(onSend).not.toHaveBeenCalled();
  });
});
