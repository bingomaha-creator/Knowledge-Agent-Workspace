import { useNavigate, useParams, useSearchParams } from 'react-router';
import { KnowledgeWorkspace } from '@/features/knowledge/KnowledgeWorkspace';

export function Knowledge() {
  const navigate = useNavigate();
  const { documentId } = useParams();
  const [searchParams] = useSearchParams();
  const activeBaseId = searchParams.get('base') || undefined;

  function knowledgeUrl(baseId: string, nextDocumentId?: string) {
    const path = nextDocumentId
      ? `/knowledge/${encodeURIComponent(nextDocumentId)}`
      : '/knowledge';
    return `${path}?base=${encodeURIComponent(baseId)}`;
  }

  return (
    <KnowledgeWorkspace
      activeBaseId={activeBaseId}
      documentId={documentId}
      onSelectBase={(baseId) => navigate(knowledgeUrl(baseId))}
      onOpenDocument={(nextDocumentId) => {
        if (activeBaseId) navigate(knowledgeUrl(activeBaseId, nextDocumentId));
      }}
      onCloseDocument={() => {
        if (activeBaseId) navigate(knowledgeUrl(activeBaseId));
        else navigate('/knowledge');
      }}
    />
  );
}
