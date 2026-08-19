import styled from 'styled-components';
import type { KnowledgeDocument } from '@/services/knowledgeApi';
import { useKnowledgePreview } from './knowledgeQueries';

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  h2 { margin: 0; overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
`;

const Actions = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
`;

const Button = styled.button<{ $primary?: boolean; $danger?: boolean }>`
  padding: 0.55rem 0.8rem;
  border: 1px solid ${({ $danger }) => $danger ? 'var(--color-danger)' : 'var(--color-border)'};
  border-radius: var(--radius-md);
  color: ${({ $primary, $danger }) => $primary ? 'white' : $danger ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  &:disabled { cursor: not-allowed; opacity: 0.55; }
`;

const ScrollArea = styled.div`
  min-height: 0;
  flex: 1;
  overflow-y: auto;
`;

const State = styled.div`
  display: grid;
  min-height: 16rem;
  padding: var(--space-6);
  place-content: center;
  color: var(--color-text-muted);
  text-align: center;
  strong { color: var(--color-text); }
`;

const Meta = styled.dl`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  max-width: 60rem;
  margin: 0 auto;
  padding: var(--space-4) var(--space-6) 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  div { display: flex; gap: 0.35rem; }
  dt { font-weight: 700; }
  dd { margin: 0; }
`;

const Truncated = styled.p`
  max-width: 60rem;
  margin: var(--space-3) auto 0;
  padding: 0 var(--space-6);
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;

const Content = styled.pre`
  max-width: 60rem;
  margin: 0 auto;
  padding: var(--space-6);
  color: var(--color-text);
  font: inherit;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

function processingLabel(status: KnowledgeDocument['status']) {
  return { queued: '等待处理', processing: '处理中', ready: '已就绪', failed: '处理失败' }[status];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

type Props = {
  baseId?: string;
  documentId: string;
  fallbackDocument?: KnowledgeDocument;
  publishPending: boolean;
  withdrawPending: boolean;
  deletePending: boolean;
  onClose: () => void;
  onPublish: (document: KnowledgeDocument) => void;
  onWithdraw: (document: KnowledgeDocument) => void;
  onDelete: (document: KnowledgeDocument) => void;
};

export function KnowledgeDocumentPreview({
  baseId,
  documentId,
  fallbackDocument,
  publishPending,
  withdrawPending,
  deletePending,
  onClose,
  onPublish,
  onWithdraw,
  onDelete
}: Props) {
  const previewQuery = useKnowledgePreview(baseId, documentId);
  const document = previewQuery.data?.document;

  return (
    <>
      <Header>
        <Actions>
          <Button onClick={onClose}>返回文档列表</Button>
          <h2>{document?.name || fallbackDocument?.name || '文档预览'}</h2>
        </Actions>
        {document && (
          <Actions>
            {document.publicationStatus === 'published' ? (
              <Button disabled={withdrawPending} onClick={() => onWithdraw(document)}>撤回发布</Button>
            ) : (
              <Button
                $primary
                disabled={document.status !== 'ready' || publishPending}
                onClick={() => onPublish(document)}
              >发布为可检索知识</Button>
            )}
            <Button $danger disabled={deletePending} onClick={() => onDelete(document)}>删除</Button>
          </Actions>
        )}
      </Header>
      <ScrollArea>
        {previewQuery.isLoading && <State>正在加载文档预览…</State>}
        {previewQuery.isError && <State><strong>无法加载文档预览</strong><br />{errorMessage(previewQuery.error)}</State>}
        {previewQuery.data && (
          <>
            <Meta>
              <div><dt>处理状态</dt><dd>{processingLabel(previewQuery.data.document.status)}</dd></div>
              <div><dt>发布状态</dt><dd>{previewQuery.data.document.publicationStatus === 'published' ? '已发布' : '草稿'}</dd></div>
              <div><dt>字符数</dt><dd>{previewQuery.data.preview.characterCount}</dd></div>
              <div><dt>分块数</dt><dd>{previewQuery.data.preview.chunkCount}</dd></div>
              <div><dt>标题</dt><dd>{previewQuery.data.preview.headings.join(' / ') || '无'}</dd></div>
            </Meta>
            {previewQuery.data.preview.truncated && <Truncated>预览内容已截断。</Truncated>}
            <Content>{previewQuery.data.preview.excerpt}</Content>
          </>
        )}
      </ScrollArea>
    </>
  );
}
