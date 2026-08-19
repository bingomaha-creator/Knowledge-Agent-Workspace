import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react';
import styled from 'styled-components';
import type { KnowledgeBase, KnowledgeDocument } from '@/services/knowledgeApi';
import {
  resolveKnowledgeBaseId,
  useKnowledgeBases,
  useKnowledgeDocuments
} from './knowledgeQueries';
import { useKnowledgeMutations } from './useKnowledgeMutations';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';
import { KnowledgeDocumentPreview } from './KnowledgeDocumentPreview';

type KnowledgeWorkspaceProps = {
  activeBaseId?: string;
  documentId?: string;
  onSelectBase: (id: string) => void;
  onOpenDocument: (id: string) => void;
  onCloseDocument: () => void;
};

const Workspace = styled.section`
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
`;

const WorkspaceHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  h1 { margin: 0; font-size: 1.125rem; }
  p { margin: 0.25rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }

  @media (max-width: 48rem) {
    > button { display: none; }
  }
`;

const WorkspaceBody = styled.div`
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
  flex: 1;
  min-height: 0;

  @media (max-width: 48rem) {
    display: block;
    overflow: hidden;
  }
`;

const MainPanel = styled.main`
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
`;

const MainToolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  @media (max-width: 48rem) {
    flex-direction: column;
    align-items: stretch;
    padding: var(--space-3);

    > div:last-child {
      width: 100%;

      > * {
        flex: 1;
        text-align: center;
      }
    }
  }
`;

const MobileBaseControls = styled.div`
  display: none;
  min-width: 0;
  flex: 1;
  gap: var(--space-2);

  @media (max-width: 48rem) { display: flex; }
`;

const Select = styled.select`
  min-width: 0;
  flex: 1;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  background: var(--color-surface);
`;

const ToolbarCopy = styled.div`
  min-width: 0;
  h2 { margin: 0; overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
  p { margin: 0.2rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }

  @media (max-width: 48rem) { display: none; }
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

const UploadLabel = styled.label`
  padding: 0.55rem 0.8rem;
  border-radius: var(--radius-md);
  color: white;
  background: var(--color-primary);
  font-size: 0.8125rem;
  cursor: pointer;

  input { position: absolute; width: 1px; height: 1px; opacity: 0; }
`;

const ScrollArea = styled.div`
  min-height: 0;
  flex: 1;
  overflow-y: auto;
`;

const DocumentList = styled.div`
  display: grid;
`;

const DocumentRow = styled.article`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  h3 { margin: 0; overflow: hidden; font-size: 0.9375rem; text-overflow: ellipsis; white-space: nowrap; }
  p { margin: 0.3rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }

  @media (max-width: 40rem) {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: var(--space-4);
  }
`;

const StatusGroup = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.35rem;
`;

const Status = styled.span`
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-background);
  font-size: 0.6875rem;
`;

const TextButton = styled.button`
  padding: 0.45rem 0.6rem;
  border: 0;
  color: var(--color-primary);
  background: transparent;
  cursor: pointer;
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

const Notice = styled.p<{ $error?: boolean }>`
  margin: 0;
  padding: var(--space-2) var(--space-5);
  color: ${({ $error }) => $error ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $error }) => $error ? 'var(--color-danger-surface)' : 'var(--color-background)'};
  font-size: 0.75rem;

  button {
    margin-left: var(--space-2);
    border: 0;
    color: inherit;
    background: transparent;
    text-decoration: underline;
    cursor: pointer;
  }
`;

const Overlay = styled.div`
  position: fixed;
  z-index: 50;
  inset: 0;
  display: grid;
  padding: var(--space-4);
  place-items: center;
  background: rgb(15 23 42 / 45%);
`;

const Dialog = styled.section`
  width: min(30rem, 100%);
  max-height: min(42rem, calc(100dvh - 2rem));
  overflow-y: auto;
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);

  header, form, section { padding: var(--space-4); }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border); }
  h2, h3 { margin: 0; font-size: 1rem; }
  form { display: grid; gap: var(--space-3); border-bottom: 1px solid var(--color-border); }
  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }
  input { padding: 0.65rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); background: var(--color-background); }
`;

const DialogBase = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
  &:last-child { border-bottom: 0; }
`;

function processingLabel(status: KnowledgeDocument['status']) {
  return { queued: '等待处理', processing: '处理中', ready: '已就绪', failed: '处理失败' }[status];
}

function publicationLabel(status: KnowledgeDocument['publicationStatus']) {
  return status === 'published' ? '已发布' : '草稿';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export function KnowledgeWorkspace({
  activeBaseId: requestedBaseId,
  documentId,
  onSelectBase,
  onOpenDocument,
  onCloseDocument
}: KnowledgeWorkspaceProps) {
  const basesQuery = useKnowledgeBases();
  const bases = basesQuery.data || [];
  const activeBaseId = resolveKnowledgeBaseId(bases, requestedBaseId);
  const activeBase = bases.find((base) => base.id === activeBaseId);
  const documentsQuery = useKnowledgeDocuments(activeBaseId);
  const documents = documentsQuery.data || [];
  const mutations = useKnowledgeMutations();
  const [manageOpen, setManageOpen] = useState(false);
  const [newBaseName, setNewBaseName] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const managerTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (basesQuery.isSuccess && activeBaseId && activeBaseId !== requestedBaseId) {
      onSelectBase(activeBaseId);
    }
  }, [activeBaseId, basesQuery.isSuccess, onSelectBase, requestedBaseId]);

  useEffect(() => {
    if (!manageOpen) {
      managerTriggerRef.current?.focus();
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeManager();
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [manageOpen]);

  function openManager() {
    managerTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setManageOpen(true);
  }

  function closeManager() {
    setManageOpen(false);
  }

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === documentId),
    [documentId, documents]
  );

  async function createBase(event: FormEvent) {
    event.preventDefault();
    const name = newBaseName.trim();
    if (!name) return;
    setError('');
    try {
      const created = await mutations.createBase.mutateAsync({ name });
      setNewBaseName('');
      closeManager();
      onSelectBase(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function deleteBase(base: KnowledgeBase) {
    if (base.isDefault || !window.confirm(`永久删除资料库“${base.name}”及其中全部文档？`)) return;
    setError('');
    try {
      await mutations.deleteBase.mutateAsync(base.id);
      if (base.id === activeBaseId) {
        const fallback = resolveKnowledgeBaseId(bases.filter((item) => item.id !== base.id));
        if (fallback) onSelectBase(fallback);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    event.target.value = '';
    if (!files?.length || !activeBaseId) return;
    setError('');
    try {
      await mutations.uploadDocuments.mutateAsync({ files, baseId: activeBaseId });
      setNotice('文件已上传，后台正在处理。处理完成后可手动发布。');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function publish(document: KnowledgeDocument) {
    setError('');
    try {
      await mutations.publishDocument.mutateAsync({ baseId: document.knowledgeBaseId, documentId: document.id });
      setNotice('知识已发布，现在可供 AI 检索。');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function withdraw(document: KnowledgeDocument) {
    setError('');
    try {
      await mutations.withdrawDocument.mutateAsync({ baseId: document.knowledgeBaseId, documentId: document.id });
      setNotice('知识已撤回，不再参与新的检索。');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function removeDocument(document: KnowledgeDocument) {
    if (!window.confirm(`永久删除文档“${document.name}”？`)) return;
    try {
      await mutations.deleteDocument.mutateAsync({ baseId: document.knowledgeBaseId, documentId: document.id });
      if (document.id === documentId) onCloseDocument();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function clearDocuments() {
    if (!activeBaseId || !documents.length || !window.confirm(`永久清空“${activeBase?.name || '当前资料库'}”中的全部文档？`)) return;
    try {
      await mutations.clearDocuments.mutateAsync(activeBaseId);
      onCloseDocument();
      setNotice('当前资料库已清空。');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const showingPreview = Boolean(documentId);

  return (
    <Workspace>
      <WorkspaceHeader>
        <div>
          <h1>Knowledge</h1>
          <p>整理、处理并发布可供 AI 检索的工作区资料。</p>
        </div>
        <Button onClick={openManager}>新建资料库</Button>
      </WorkspaceHeader>

      {basesQuery.isError && (
        <Notice $error>
          无法加载资料库目录。
          <button type="button" onClick={() => basesQuery.refetch()}>重试</button>
        </Notice>
      )}
      {(notice || error) && <Notice $error={Boolean(error)}>{error || notice}</Notice>}

      <WorkspaceBody>
        <KnowledgeBasePanel bases={bases} activeBaseId={activeBaseId} onSelectBase={onSelectBase} />

        <MainPanel aria-label="知识文档工作区">
          {showingPreview ? (
            <KnowledgeDocumentPreview
              baseId={activeBaseId}
              documentId={documentId!}
              fallbackDocument={selectedDocument}
              publishPending={mutations.publishDocument.isPending}
              withdrawPending={mutations.withdrawDocument.isPending}
              deletePending={mutations.deleteDocument.isPending}
              onClose={onCloseDocument}
              onPublish={publish}
              onWithdraw={withdraw}
              onDelete={removeDocument}
            />
          ) : (
            <>
              <MainToolbar>
                <MobileBaseControls>
                  <Select
                    aria-label="当前资料库"
                    value={activeBaseId || ''}
                    onChange={(event) => onSelectBase(event.target.value)}
                  >
                    {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
                  </Select>
                  <Button onClick={openManager}>管理</Button>
                </MobileBaseControls>
                <ToolbarCopy>
                  <h2>{activeBase?.name || '资料库'}</h2>
                  <p>{documents.length} 个文档 · 上传后先处理为草稿，再手动发布</p>
                </ToolbarCopy>
                <Actions>
                  <Button onClick={() => documentsQuery.refetch()} disabled={!activeBaseId || documentsQuery.isFetching}>刷新</Button>
                  <Button $danger onClick={clearDocuments} disabled={!documents.length || mutations.clearDocuments.isPending}>清空</Button>
                  <UploadLabel>
                    上传文件
                    <input aria-label="上传知识文件" type="file" multiple accept=".md,.markdown,.txt,.json" disabled={mutations.uploadDocuments.isPending} onChange={upload} />
                  </UploadLabel>
                </Actions>
              </MainToolbar>
              <ScrollArea>
                {documentsQuery.isLoading && <State>正在加载文档…</State>}
                {documentsQuery.isError && (
                  <State>
                    <strong>无法加载文档</strong><br />
                    {errorMessage(documentsQuery.error)}<br />
                    <Button onClick={() => documentsQuery.refetch()}>重试</Button>
                  </State>
                )}
                {!documentsQuery.isLoading && !documentsQuery.isError && !documents.length && (
                  <State><strong>这个资料库还是空的</strong><br />上传 Markdown、TXT 或 JSON 文件开始整理知识。</State>
                )}
                <DocumentList>
                  {documents.map((document) => (
                    <DocumentRow key={document.id}>
                      <div><h3>{document.name}</h3><p>{document.error || '上传后保留为草稿，发布后才参与检索'}</p></div>
                      <StatusGroup>
                        <Status>{processingLabel(document.status)}</Status>
                        <Status>{publicationLabel(document.publicationStatus)}</Status>
                      </StatusGroup>
                      <TextButton type="button" aria-label={`预览 ${document.name}`} onClick={() => onOpenDocument(document.id)}>预览</TextButton>
                    </DocumentRow>
                  ))}
                </DocumentList>
              </ScrollArea>
            </>
          )}
        </MainPanel>
      </WorkspaceBody>

      {manageOpen && (
        <Overlay onMouseDown={(event) => event.target === event.currentTarget && closeManager()}>
          <Dialog ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="knowledge-manager-title">
            <header>
              <h2 id="knowledge-manager-title">资料库管理</h2>
              <Button aria-label="关闭资料库管理" onClick={closeManager}>关闭</Button>
            </header>
            <form onSubmit={createBase}>
              <label>
                资料库名称
                <input
                  autoFocus
                  aria-label="资料库名称"
                  value={newBaseName}
                  maxLength={80}
                  onChange={(event) => setNewBaseName(event.target.value)}
                />
              </label>
              <Button $primary type="submit" disabled={!newBaseName.trim() || mutations.createBase.isPending}>创建并打开</Button>
            </form>
            <section>
              <h3>现有资料库</h3>
              {bases.map((base) => (
                <DialogBase key={base.id}>
                  <div><strong>{base.name}</strong><div>{base.documentCount} 个文档</div></div>
                  {base.isDefault
                    ? <Status>默认资料库</Status>
                    : <Button $danger onClick={() => deleteBase(base)}>永久删除</Button>}
                </DialogBase>
              ))}
            </section>
          </Dialog>
        </Overlay>
      )}
    </Workspace>
  );
}
