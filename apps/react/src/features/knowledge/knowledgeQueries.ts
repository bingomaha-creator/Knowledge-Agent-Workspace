import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  knowledgeApi,
  type KnowledgeBase,
  type KnowledgeDocument
} from '@/services/knowledgeApi';

export const knowledgeQueryKeys = {
  all: ['knowledge'] as const,
  bases: () => ['knowledge', 'bases'] as const,
  documents: (knowledgeBaseId: string) => ['knowledge', 'documents', knowledgeBaseId] as const,
  preview: (knowledgeBaseId: string, documentId: string) => (
    ['knowledge', 'preview', knowledgeBaseId, documentId] as const
  )
};

export function resolveKnowledgeBaseId(
  bases: Array<Pick<KnowledgeBase, 'id' | 'isDefault'>>,
  requestedId?: string | null
) {
  if (requestedId && bases.some((base) => base.id === requestedId)) return requestedId;
  return bases.find((base) => base.isDefault)?.id || bases[0]?.id;
}

export function hasPendingKnowledgeDocuments(
  documents: Array<Pick<KnowledgeDocument, 'status'>>
) {
  return documents.some(({ status }) => status === 'queued' || status === 'processing');
}

export function useKnowledgeBases() {
  return useQuery({
    queryKey: knowledgeQueryKeys.bases(),
    queryFn: () => knowledgeApi.listBases(),
    staleTime: 60_000
  });
}

export function useKnowledgeDocuments(knowledgeBaseId?: string) {
  const pollingStartedAt = useRef<number | null>(null);

  return useQuery({
    queryKey: knowledgeQueryKeys.documents(knowledgeBaseId || ''),
    queryFn: () => knowledgeApi.listDocuments(knowledgeBaseId || ''),
    enabled: Boolean(knowledgeBaseId),
    refetchInterval: (query) => {
      const documents = query.state.data;
      if (!documents || !hasPendingKnowledgeDocuments(documents)) {
        pollingStartedAt.current = null;
        return false;
      }
      pollingStartedAt.current ??= Date.now();
      return Date.now() - pollingStartedAt.current < 60_000 ? 1_500 : false;
    }
  });
}

export function useKnowledgePreview(knowledgeBaseId?: string, documentId?: string) {
  return useQuery({
    queryKey: knowledgeQueryKeys.preview(knowledgeBaseId || '', documentId || ''),
    queryFn: () => knowledgeApi.getDocumentPreview(documentId || '', knowledgeBaseId || ''),
    enabled: Boolean(knowledgeBaseId && documentId)
  });
}
