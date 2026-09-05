import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
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

function renderCard(card: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>{card}</QueryClientProvider>
  );
}

describe('MessageCard', () => {
  it('renders sanitized markdown and expandable tool, citation, and run details', async () => {
    renderCard(<MessageCard message={message({
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
    expect(screen.getByText('工具调用')).toBeInTheDocument();
    expect(screen.getByText('参考来源')).toBeInTheDocument();
    expect(screen.getByText('回答详情')).toBeInTheDocument();

    await userEvent.click(screen.getByText('回答详情'));
    expect(screen.getByText(/输入 12 · 输出 8/)).toBeInTheDocument();
    expect(screen.getByText(/生成最终回答/)).toBeInTheDocument();
  });

  it('publishes stable cross-module intents from a user message', async () => {
    const onStartResearch = vi.fn();
    const onStartBugInvestigation = vi.fn();
    renderCard(<MessageCard
      message={message({ id: 'user-1', role: 'user', content: 'TypeError: failed' })}
      onStartResearch={onStartResearch}
      onStartBugInvestigation={onStartBugInvestigation}
    />);

    await userEvent.click(screen.getByRole('button', { name: '转为深度研究' }));
    await userEvent.click(screen.getByRole('button', { name: '转为 Bug 调查' }));
    expect(onStartResearch).toHaveBeenCalledWith({
      question: 'TypeError: failed', sourceMessageId: 'user-1'
    });
    expect(onStartBugInvestigation).toHaveBeenCalledWith({
      content: 'TypeError: failed', sourceMessageId: 'user-1'
    });
  });

  it('lets the user confirm, reject, or edit a memory candidate', async () => {
    const onReviewMemory = vi.fn();
    const onCorrectMemory = vi.fn();
    renderCard(<MessageCard
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
    renderCard(<MessageCard message={message({
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
