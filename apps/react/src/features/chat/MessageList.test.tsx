import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chat.types';
import { MessageList } from './MessageList';

vi.mock('react-virtuoso', async () => {
  const { forwardRef, useState, useImperativeHandle } = await import('react');
  return {
    Virtuoso: forwardRef(function VirtualWindow({ data, itemContent, followOutput, atBottomStateChange }: {
      data: ChatMessage[]; itemContent: (index: number, message: ChatMessage) => ReactNode;
      followOutput: (atBottom: boolean) => string | false;
      atBottomStateChange: (atBottom: boolean) => void;
    }, ref) {
      const [visible, setVisible] = useState(true);
      useImperativeHandle(ref, () => ({ scrollToIndex() {} }));
      return <>
        <button onClick={() => setVisible((value) => !value)}>切换可见窗口</button>
        <button onClick={() => atBottomStateChange(true)}>报告位于底部</button>
        <output aria-label="自动跟随">{String(followOutput(true))}</output>
        {visible ? data.map((message, index) => <div key={message.id}>{itemContent(index, message)}</div>) : null}
      </>;
    })
  };
});

describe('MessageList reading choices', () => {
  it('restores disclosures after a virtual item remounts and resets them on leaving the conversation', async () => {
    const message: ChatMessage = {
      id: 'message-1', sessionId: 'session-1', sequenceNo: 1, requestId: 'request-1',
      role: 'assistant', content: '回答', status: 'done', citations: [],
      tools: [{ id: 'tool-1', name: 'get_current_time', status: 'success', args: {}, result: '12:00' }],
      memoryCandidate: null, runId: null, errorCode: '', errorMessage: '', createdAt: 1, updatedAt: 1,
      run: { id: 'run-1', status: 'success' }
    };
    const client = new QueryClient();
    const renderList = (key: string) => <QueryClientProvider client={client}>
      <MessageList key={key} messages={[message]} hasEarlierMessages={false} loadingEarlierMessages={false} loadEarlierMessages={async () => {}} />
    </QueryClientProvider>;
    const view = render(renderList('first-visit'));
    await userEvent.click(screen.getByRole('button', { name: /获取当前时间/ }));
    await userEvent.click(screen.getByRole('button', { name: /执行详情/ }));
    expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '报告位于底部' }));
    expect(screen.getByLabelText('自动跟随')).toHaveTextContent('false');
    await userEvent.click(screen.getByRole('button', { name: '切换可见窗口' }));
    expect(screen.queryByRole('button', { name: /执行详情/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '切换可见窗口' }));
    expect(screen.getByRole('button', { name: /获取当前时间/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /执行详情/ })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(screen.getByLabelText('自动跟随')).toHaveTextContent('auto');
    view.rerender(renderList('return-visit'));
    expect(screen.getByRole('button', { name: /执行详情/ })).toHaveAttribute('aria-expanded', 'false');
  });
});
