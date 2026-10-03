import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '@/services/chatApi';
import type { ChatMessage } from './chat.types';
import { MessageCard } from './MessageCard';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1', sessionId: 'session-1', sequenceNo: 1, requestId: 'request-1',
    role: 'assistant', content: '', status: 'done', citations: [], tools: [],
    memoryCandidate: null, runId: null, errorCode: '', errorMessage: '', createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function ControlledMessageCard(props: Omit<ComponentProps<typeof MessageCard>, 'expandedDetails' | 'onDetailsChange'>) {
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set());
  return <MessageCard {...props} expandedDetails={expandedDetails} onDetailsChange={(key, open) => {
    setExpandedDetails((current) => {
      const next = new Set(current);
      if (open) next.add(key); else next.delete(key);
      return next;
    });
  }} />;
}

function renderCard(card: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>{card}</QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('MessageCard', () => {
  it('keeps tool and run disclosures open as the stream completes', async () => {
    const onReadingStart = vi.fn();
    const running = message({
      status: 'streaming',
      tools: [{ id: 'tool-1', name: 'retrieve_knowledge', args: { query: 'React' }, status: 'running' }],
      run: { id: 'run-1', status: 'running', spans: [] }
    });
    const queryClient = new QueryClient();
    const view = render(<QueryClientProvider client={queryClient}><ControlledMessageCard message={running} onReadingStart={onReadingStart} /></QueryClientProvider>);
    const tool = screen.getByRole('button', { name: /检索资料库/ });
    const thinking = screen.getByRole('button', { name: /正在执行/ });
    expect(tool).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(tool);
    await userEvent.click(thinking);
    expect(onReadingStart).toHaveBeenCalledTimes(2);
    view.rerender(<QueryClientProvider client={queryClient}><ControlledMessageCard message={{
      ...running, status: 'done',
      tools: [{ ...running.tools[0], status: 'success', result: '找到资料' }],
      run: { id: 'run-1', status: 'success', spans: [] }
    }} onReadingStart={onReadingStart} /></QueryClientProvider>);
    expect(screen.getByRole('button', { name: /执行详情/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /检索资料库.*已完成/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('找到资料')).toBeVisible();
  });

  it.each([
    ['cancelled', '已停止 · 执行详情'],
    ['interrupted', '执行中断 · 查看详情'],
    ['error', '执行失败 · 查看详情']
  ] as const)('stops unfinished tool indicators for %s without claiming tool failure', async (status, title) => {
    renderCard(<ControlledMessageCard message={message({
      status,
      tools: [{ id: 'tool-1', name: 'retrieve_knowledge', args: {}, status: 'running' }],
      run: { id: 'run-1', status: 'running', spans: [] }
    })} />);
    const tools = screen.getByRole('region', { name: '工具调用' });
    expect(within(tools).getByRole('button', { name: /未完成，结果未确认/ })).toBeInTheDocument();
    expect(tools.querySelector('[data-status="running"]')).toBeNull();
    expect(tools.querySelector('[data-status="error"]')).toBeNull();
    expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument();
  });

  it('keeps a failed history read separate from execution failure and lets the reader retry', async () => {
    const getRun = vi.spyOn(chatApi, 'getRun')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'run-1', status: 'success', inputTokens: 12 });
    renderCard(<ControlledMessageCard message={message({ content: '已保存的回答', runId: 'run-1' })} />);
    await userEvent.click(screen.getByRole('button', { name: /执行详情/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('执行详情读取失败');
    expect(screen.getByText('已保存的回答')).toBeVisible();
    expect(screen.queryByRole('button', { name: /执行失败/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试读取详情' }));
    expect(await screen.findByText(/输入 12/)).toBeVisible();
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it('renders sanitized markdown and expandable tool, citation, and run details', async () => {
    renderCard(<ControlledMessageCard message={message({
      content: '## 安全标题\n<script>window.pwned=true</script>\n[危险链接](javascript:alert(1))',
      tools: [{ id: 'tool-1', name: 'retrieve_knowledge', args: { query: 'React' }, status: 'success', result: '找到资料' }],
      citations: [{ id: 'source-1', title: 'React 文档', snippet: '可靠片段', source: 'project.md' }],
      run: {
        id: 'run-1', status: 'success', inputTokens: 12, outputTokens: 8,
        spans: [{ id: 'span-1', name: 'generation', kind: 'model', status: 'success', durationMs: 80 }]
      }
    })} />);

    expect(screen.getByText('安全标题')).toBeInTheDocument();
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument();
    expect(screen.getByText((_text, element) => (
      element?.tagName === 'P' && Boolean(element.textContent?.includes('危险链接'))
    ))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '工具调用' })).toBeInTheDocument();
    expect(screen.getByText('参考来源')).toBeInTheDocument();
    expect(screen.getByText('执行详情')).toBeInTheDocument();

    await userEvent.click(screen.getByText('执行详情'));
    expect(screen.getByText(/输入 12 · 输出 8/)).toBeInTheDocument();
    expect(screen.getByText(/生成最终回答/)).toBeInTheDocument();
  });

  it('keeps the Research intent while retiring Bug investigation', async () => {
    const onStartResearch = vi.fn();
    renderCard(<ControlledMessageCard
      message={message({ id: 'user-1', role: 'user', content: 'TypeError: failed' })}
      onStartResearch={onStartResearch}
    />);

    await userEvent.click(screen.getByRole('button', { name: '转为深度研究' }));
    expect(screen.queryByRole('button', { name: '转为 Bug 调查' })).not.toBeInTheDocument();
    expect(onStartResearch).toHaveBeenCalledWith({
      question: 'TypeError: failed', sourceMessageId: 'user-1'
    });
  });

  it('lets the user confirm, reject, or edit a memory candidate', async () => {
    const onReviewMemory = vi.fn();
    const onCorrectMemory = vi.fn();
    renderCard(<ControlledMessageCard
      message={message({ memoryCandidate: {
        id: 'memory-1', type: 'preference', title: '回答偏好', content: '使用中文',
        confidence: 0.92, status: 'candidate', sourceConversationId: 'session-1',
        sourceMessageIds: ['user-1'], sourceExcerpt: '请使用中文'
      } })}
      onReviewMemory={onReviewMemory}
      onCorrectMemory={onCorrectMemory}
    />);

    await userEvent.click(screen.getByRole('button', { name: '确认记忆' }));
    expect(onReviewMemory).toHaveBeenCalledWith('message-1', 'memory-1', 'confirmed');
    await userEvent.click(screen.getByRole('button', { name: '编辑后确认' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '候选记忆内容' }));
    await userEvent.type(screen.getByRole('textbox', { name: '候选记忆内容' }), '始终使用中文');
    await userEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    expect(onCorrectMemory).toHaveBeenCalledWith('message-1', 'memory-1', expect.objectContaining({
      content: '始终使用中文', status: 'corrected'
    }));
  });

  it('maps read_knowledge_document to a readable label and keeps the summary summary-shaped', async () => {
    renderCard(<ControlledMessageCard message={message({
      tools: [{
        id: 'tool-read',
        name: 'read_knowledge_document',
        args: { documentId: 'doc-1', offset: 0, limit: 12000 },
        status: 'success',
        result: {
          document: { id: 'doc-1', name: 'probe.md', knowledgeBaseId: 'kb-default' },
          offset: 0,
          returnedCharacters: 12000,
          totalCharacters: 18000,
          truncated: true,
          nextOffset: 12000
        }
      }]
    })} />);

    expect(screen.getByText('读取知识文档')).toBeInTheDocument();
    const text = document.body.textContent || '';
    expect(text).toContain('18000');
    expect(text).toContain('12000');
    // 摘要不包含正文内容字段
    expect(text).not.toContain('SECRET-CONTENT');
  });
});
