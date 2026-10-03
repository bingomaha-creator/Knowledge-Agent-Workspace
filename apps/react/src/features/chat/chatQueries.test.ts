import { describe, expect, it } from 'vitest';
import { messagesFromPages } from './chatQueries';
import type { ChatMessage, ChatMessagePage } from './chat.types';

function message(id: string, sequenceNo: number): ChatMessage {
  return {
    id,
    sessionId: 'session-1',
    sequenceNo,
    requestId: `request-${sequenceNo}`,
    role: sequenceNo % 2 ? 'user' : 'assistant',
    content: id,
    status: 'done',
    citations: [],
    tools: [],
    memoryCandidate: null,
    runId: null,
    errorCode: '',
    errorMessage: '',
    createdAt: sequenceNo,
    updatedAt: sequenceNo
  };
}

describe('chat query projections', () => {
  it('projects newest-first infinite pages into one deduplicated chronological list', () => {
    const newest: ChatMessagePage = {
      messages: [message('m-3', 3), message('m-4', 4)],
      nextCursor: 3
    };
    const older: ChatMessagePage = {
      messages: [message('m-1', 1), message('m-2', 2), message('m-3', 3)],
      nextCursor: null
    };

    expect(messagesFromPages({ pages: [newest, older], pageParams: [null, 3] })
      .map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
  });
});
