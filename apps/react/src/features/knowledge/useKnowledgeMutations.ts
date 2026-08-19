import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  knowledgeApi,
  type KnowledgeBase,
  type KnowledgeDocument
} from '@/services/knowledgeApi';
import { knowledgeQueryKeys } from './knowledgeQueries';

type DocumentVariables = { baseId: string; documentId: string };

export function useKnowledgeMutations() {
  const queryClient = useQueryClient();

  function refreshCatalog() {
    return queryClient.invalidateQueries({ queryKey: knowledgeQueryKeys.bases() });
  }

  function replaceDocument(document: KnowledgeDocument) {
    queryClient.setQueryData<KnowledgeDocument[]>(
      knowledgeQueryKeys.documents(document.knowledgeBaseId),
      (documents = []) => documents.map((item) => item.id === document.id ? document : item)
    );
    queryClient.setQueryData(
      knowledgeQueryKeys.preview(document.knowledgeBaseId, document.id),
      (current: { document: KnowledgeDocument; preview: unknown } | undefined) => (
        current ? { ...current, document } : current
      )
    );
  }

  const createBase = useMutation({
    mutationFn: (input: { name: string; description?: string }) => knowledgeApi.createBase(input),
    onSuccess: (created) => {
      queryClient.setQueryData<KnowledgeBase[]>(knowledgeQueryKeys.bases(), (bases = []) => [
        ...bases.filter((base) => base.id !== created.id),
        created
      ]);
    }
  });

  const deleteBase = useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteBase(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<KnowledgeBase[]>(
        knowledgeQueryKeys.bases(),
        (bases = []) => bases.filter((base) => base.id !== id)
      );
      queryClient.removeQueries({ queryKey: knowledgeQueryKeys.documents(id) });
    }
  });

  const uploadDocuments = useMutation({
    mutationFn: ({ files, baseId }: { files: FileList | File[]; baseId: string }) => (
      knowledgeApi.uploadDocuments(files, baseId)
    ),
    onSuccess: (created, { baseId }) => {
      queryClient.setQueryData<KnowledgeDocument[]>(
        knowledgeQueryKeys.documents(baseId),
        (documents = []) => [...created, ...documents]
      );
      void refreshCatalog();
    }
  });

  const publishDocument = useMutation({
    mutationFn: ({ baseId, documentId }: DocumentVariables) => (
      knowledgeApi.publishDocument(documentId, baseId)
    ),
    onSuccess: (document) => {
      replaceDocument(document);
      void refreshCatalog();
    }
  });

  const withdrawDocument = useMutation({
    mutationFn: ({ baseId, documentId }: DocumentVariables) => (
      knowledgeApi.withdrawDocument(documentId, baseId)
    ),
    onSuccess: (document) => {
      replaceDocument(document);
      void refreshCatalog();
    }
  });

  const deleteDocument = useMutation({
    mutationFn: ({ baseId, documentId }: DocumentVariables) => (
      knowledgeApi.deleteDocument(documentId, baseId)
    ),
    onSuccess: (_result, { baseId, documentId }) => {
      queryClient.setQueryData<KnowledgeDocument[]>(
        knowledgeQueryKeys.documents(baseId),
        (documents = []) => documents.filter((document) => document.id !== documentId)
      );
      queryClient.removeQueries({ queryKey: knowledgeQueryKeys.preview(baseId, documentId) });
      void refreshCatalog();
    }
  });

  const clearDocuments = useMutation({
    mutationFn: (baseId: string) => knowledgeApi.clearDocuments(baseId),
    onSuccess: (_result, baseId) => {
      queryClient.setQueryData(knowledgeQueryKeys.documents(baseId), []);
      queryClient.removeQueries({ queryKey: [...knowledgeQueryKeys.all, 'preview', baseId] });
      void refreshCatalog();
    }
  });

  return {
    createBase,
    deleteBase,
    uploadDocuments,
    publishDocument,
    withdrawDocument,
    deleteDocument,
    clearDocuments
  };
}
