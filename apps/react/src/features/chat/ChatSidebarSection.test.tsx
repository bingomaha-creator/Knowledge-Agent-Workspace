import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatStreamStore } from './chatStreamStore';
import { ChatSidebarSection } from './ChatSidebarSection';

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/chat/session-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ChatSidebarSection />, { wrapper: Wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useChatStreamStore.getState().reset();
});

describe('ChatSidebarSection', () => {
  it('requires confirmation before permanently deleting a session', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat/sessions' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ sessions: [{
          id: 'session-1', title: '需要删除的会话', presetId: 'general', ragEnabled: true,
          knowledgeBaseIds: [], messageCount: 2, createdAt: 1, updatedAt: 1
        }] }), { status: 200 });
      }
      if (url === '/api/chat/sessions/session-1' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    renderSidebar();
    const deleteButton = await screen.findByRole('button', { name: '删除会话 需要删除的会话' });

    await userEvent.click(deleteButton);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalledWith('/api/chat/sessions/session-1', expect.objectContaining({
      method: 'DELETE'
    }));

    await userEvent.click(deleteButton);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/api/chat/sessions/session-1',
      expect.objectContaining({ method: 'DELETE' })
    ));
  });

  it('disables new, switch, and delete actions while a stream is active', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [{
      id: 'session-2', title: '其他会话', presetId: 'general', ragEnabled: true,
      knowledgeBaseIds: [], messageCount: 2, createdAt: 1, updatedAt: 1
    }] }), { status: 200 })));
    useChatStreamStore.getState().start('request-1', vi.fn());
    renderSidebar();

    expect(await screen.findByRole('button', { name: '＋ 发起新对话' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: '其他会话' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除会话 其他会话' })).toBeDisabled();
    useChatStreamStore.getState().fail({ code: 'TEST_DONE', message: 'done', details: '' });
  });
});
