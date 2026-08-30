import { useNavigate, useParams } from 'react-router';
import { ChatWorkspace } from '@/features/chat/ChatWorkspace';

export function Chat() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();

  return (
    <ChatWorkspace
      sessionId={sessionId}
      onSessionAccepted={(acceptedSessionId) => {
        navigate(`/chat/${encodeURIComponent(acceptedSessionId)}`, { replace: true });
      }}
      onStartResearch={(chatSeed) => {
        navigate('/research/new', { state: { researchDraftSeed: chatSeed } });
      }}
      onStartBugInvestigation={(chatSeed) => {
        const firstLine = chatSeed.content.split('\n').find((line) => line.trim())?.trim() || '';
        navigate('/bugs/investigations/new', {
          state: {
            bugInvestigationSeed: {
              title: firstLine.slice(0, 120),
              evidence: { type: 'error', content: chatSeed.content },
              sourceMessageId: chatSeed.sourceMessageId,
              sourceSessionId: chatSeed.sourceSessionId
            }
          }
        });
      }}
    />
  );
}
