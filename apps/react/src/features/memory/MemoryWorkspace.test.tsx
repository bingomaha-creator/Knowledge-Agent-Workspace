import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '@/services/memoryApi';
import { MemoryWorkspace } from './MemoryWorkspace';
import { normalizeMemoryFilters, type MemoryFilters } from './memoryQueries';

const candidate: MemoryRecord = {
  id: 'memory-1',
  type: 'preference',
  title: '偏好简洁回答',
  content: '用户偏好简洁、直接的回答。',
  details: {},
  confidence: 0.85,
  status: 'candidate',
  sourceConversationId: 'chat-1',
  sourceMessageIds: ['message-1'],
  sourceExcerpt: '请说得简洁一点。',
  createdAt: 1,
  updatedAt: 2,
  confirmedAt: null
};

function renderWorkspace(
  props: Partial<Parameters<typeof MemoryWorkspace>[0]> = {},
  filters: MemoryFilters = normalizeMemoryFilters({})
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const defaults = {
    filters,
    memoryId: undefined,
    onFiltersChange: vi.fn(),
    onOpenMemory: vi.fn(),
    onCloseMemory: vi.fn(),
    onCreated: vi.fn(),
    onOpenSourceConversation: vi.fn()
  };
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    ...render(<MemoryWorkspace {...defaults} {...props} />, { wrapper: Wrapper }),
    ...defaults,
    ...props
  };
}

function stubMemoryFetch(memories: MemoryRecord[] = [candidate]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/memories?limit=50&offset=0') {
      return Response.json({ memories, total: memories.length });
    }
    if (url === '/api/memories?status=candidate&limit=50&offset=0') {
      const candidates = memories.filter((memory) => memory.status === 'candidate');
      return Response.json({ memories: candidates, total: candidates.length });
    }
    if (url === '/api/memories?limit=1&offset=0') {
      return Response.json({ memories: memories.slice(0, 1), total: memories.length });
    }
    if (url === '/api/memories?status=candidate&limit=1&offset=0') {
      const candidates = memories.filter((memory) => memory.status === 'candidate');
      return Response.json({ memories: candidates.slice(0, 1), total: candidates.length });
    }
    if (url === `/api/memories/${candidate.id}` && init?.method === 'GET') {
      return Response.json({ memory: candidate });
    }
    if (url === `/api/memories/${candidate.id}` && init?.method === 'PATCH') {
      return Response.json({ memory: { ...candidate, ...JSON.parse(String(init.body)) } });
    }
    if (url === '/api/memories' && init?.method === 'POST') {
      return Response.json({
        memory: { ...candidate, ...JSON.parse(String(init.body)), id: 'memory-new', status: 'confirmed' }
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('MemoryWorkspace', () => {
  it('shows the list without selecting the first memory automatically', async () => {
    stubMemoryFetch();
    const result = renderWorkspace();

    expect(await screen.findByText('偏好简洁回答')).toBeInTheDocument();
    expect(screen.getByText('从左侧选择一条记忆查看详情。')).toBeInTheDocument();
    expect(result.onOpenMemory).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '打开记忆 偏好简洁回答' }));
    expect(result.onOpenMemory).toHaveBeenCalledWith('memory-1');
  });

  it('closes a candidate detail after confirmation moves it out of the active filter', async () => {
    stubMemoryFetch();
    const onCloseMemory = vi.fn();
    renderWorkspace(
      { memoryId: candidate.id, onCloseMemory },
      normalizeMemoryFilters({ status: 'candidate' })
    );

    await userEvent.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() => expect(onCloseMemory).toHaveBeenCalled());
    expect(await screen.findByText('记忆已确认。')).toBeInTheDocument();
  });

  it('creates an explicitly authored memory and publishes its navigation intent', async () => {
    stubMemoryFetch([]);
    const onCreated = vi.fn();
    renderWorkspace({ onCreated });

    await userEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    await userEvent.type(screen.getByRole('textbox', { name: '新记忆标题' }), '常用技术栈');
    await userEvent.type(screen.getByRole('textbox', { name: '新记忆内容' }), '主要使用 React 与 TypeScript。');
    await userEvent.click(screen.getByRole('button', { name: '保存为已确认' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('memory-new'));
  });

  it('lets the type filter be cleared back to 全部类型 after narrowing', async () => {
    stubMemoryFetch();
    const onFiltersChange = vi.fn();
    // 用真实受控状态驱动：受控 value 必须随 onChange 更新，“选回全部”才会发出第二次回调。
    function Harness() {
      const [filters, setFilters] = useState(normalizeMemoryFilters({}));
      return (
        <MemoryWorkspace
          filters={filters}
          memoryId={undefined}
          onFiltersChange={(next) => { onFiltersChange(next); setFilters(next); }}
          onOpenMemory={vi.fn()}
          onCloseMemory={vi.fn()}
          onCreated={vi.fn()}
          onOpenSourceConversation={vi.fn()}
        />
      );
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    );

    const trigger = await screen.findByRole('combobox', { name: '记忆类型筛选' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '事实' }));
    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'fact' }))
    );

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '全部类型' }));
    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: undefined }))
    );
  });
});
