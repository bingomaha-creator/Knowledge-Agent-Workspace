import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat';

vi.mock('@/features/chat/ChatWorkspace', () => ({
  ChatWorkspace: ({ onStartBugInvestigation }: {
    onStartBugInvestigation: (seed: {
      content: string;
      sourceSessionId: string;
      sourceMessageId: string;
    }) => void;
  }) => (
    <button type="button" onClick={() => onStartBugInvestigation({
      content: 'TypeError: failed\n完整日志',
      sourceSessionId: 'session-1',
      sourceMessageId: 'message-1'
    })}>发起 Bug 调查</button>
  )
}));

function Destination() {
  const location = useLocation();
  return <pre>{JSON.stringify({ pathname: location.pathname, state: location.state })}</pre>;
}

describe('Chat page cross-module navigation', () => {
  it('opens an editable Bug investigation draft without persisting it', () => {
    render(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Routes>
          <Route path="/chat/:sessionId" element={<Chat />} />
          <Route path="*" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: '发起 Bug 调查' }));

    expect(screen.getByText(/"pathname":"\/bugs\/investigations\/new"/)).toBeInTheDocument();
    expect(screen.getByText(/"title":"TypeError: failed"/)).toBeInTheDocument();
    expect(screen.getByText(/"type":"error"/)).toBeInTheDocument();
    expect(screen.getByText(/"sourceSessionId":"session-1"/)).toBeInTheDocument();
    expect(screen.getByText(/"sourceMessageId":"message-1"/)).toBeInTheDocument();
  });
});
