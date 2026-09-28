import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';
import { Chat } from './Chat';

vi.mock('@/features/chat/ChatWorkspace', () => ({
  ChatWorkspace: ({ onStartResearch, onStartBugInvestigation }: {
    onStartResearch: (seed: unknown) => void;
    onStartBugInvestigation: (seed: unknown) => void;
  }) => <>
    <button onClick={() => onStartResearch({ question: '消息中的研究问题', sourceMessageId: 'message-1', knowledgeBaseIds: ['kb-1'] })}>发起研究</button>
    <button onClick={() => onStartBugInvestigation({ content: 'TypeError: failed\n完整日志', sourceSessionId: 'session-1', sourceMessageId: 'message-1' })}>发起 Bug 调查</button>
  </>
}));

it('sends a Chat draft to the active research route, without creating a run', async () => {
  const router = createMemoryRouter([
    { path: '/chat', element: <Chat /> },
    { path: '/research-new/new', element: <p>研究草稿</p> }
  ], { initialEntries: ['/chat'] });
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole('button', { name: '发起研究' }));
  expect(await screen.findByText('研究草稿')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/research-new/new');
  expect(router.state.location.state.researchDraftSeed.question).toBe('消息中的研究问题');
});

it('preserves navigation to an editable Bug investigation draft', async () => {
  const router = createMemoryRouter([
    { path: '/chat/:sessionId', element: <Chat /> },
    { path: '/bugs/investigations/new', element: <p>调查草稿</p> }
  ], { initialEntries: ['/chat/session-1'] });
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole('button', { name: '发起 Bug 调查' }));
  expect(await screen.findByText('调查草稿')).toBeInTheDocument();
  expect(router.state.location.state.bugInvestigationSeed).toMatchObject({
    title: 'TypeError: failed', evidence: { type: 'error', content: 'TypeError: failed\n完整日志' }, sourceSessionId: 'session-1', sourceMessageId: 'message-1'
  });
});
