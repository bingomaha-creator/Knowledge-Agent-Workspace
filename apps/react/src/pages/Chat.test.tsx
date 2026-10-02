import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';
import { Chat } from './Chat';

vi.mock('@/features/chat/ChatWorkspace', () => ({
  ChatWorkspace: ({ onStartResearch }: {
    onStartResearch: (seed: unknown) => void;
  }) => <>
    <button onClick={() => onStartResearch({ question: '消息中的研究问题', sourceMessageId: 'message-1', knowledgeBaseIds: ['kb-1'] })}>发起研究</button>
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
