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
    />
  );
}
