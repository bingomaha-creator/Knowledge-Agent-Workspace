import { useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import type { MemoryRecord, MemoryType } from '@/services/memoryApi';
import { Select } from '@/ui/Select';
import { memoryTypeDescription, memoryTypeLabel, memoryTypes } from './memoryDisplay';
import { useMemoryMutations } from './useMemoryMutations';

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
  width: min(34rem, 100%);
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  border-radius: var(--radius-card);
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);

  header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--color-border); }
  h2 { margin: 0; font-size: 1rem; }
  form { display: grid; gap: var(--space-4); padding: var(--space-4); }
  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }
  input, textarea { width: 100%; padding: 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text); background: var(--color-background); font: inherit; }
  small { color: var(--color-text-subtle); }
`;

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
`;

const Button = styled.button<{ $primary?: boolean }>`
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: ${({ $primary }) => $primary ? 'white' : 'var(--color-text)'};
  background: ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
  &:disabled { opacity: 0.55; }
`;

const ErrorText = styled.p`
  margin: 0;
  color: var(--color-danger);
  font-size: 0.75rem;
`;

export function MemoryCreateDialog({
  open,
  returnFocus,
  onClose,
  onCreated
}: {
  open: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onCreated: (memory: MemoryRecord) => void;
}) {
  const mutations = useMemoryMutations();
  const dialogRef = useRef<HTMLElement>(null);
  const [type, setType] = useState<MemoryType>('fact');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      returnFocus?.focus();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !mutations.create.isPending) onClose();
      if (event.key !== 'Tab') return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea');
      if (!nodes?.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mutations.create.isPending, onClose, open, returnFocus]);

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setError('');
    try {
      const created = await mutations.create.mutateAsync({
        type, title: title.trim(), content: content.trim()
      });
      setType('fact'); setTitle(''); setContent('');
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建长期记忆失败');
    }
  }

  return (
    <Overlay onMouseDown={(event) => event.target === event.currentTarget && !mutations.create.isPending && onClose()}>
      <Dialog ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-memory-title">
        <header>
          <h2 id="create-memory-title">新建长期记忆</h2>
          <Button type="button" aria-label="关闭新建记忆" disabled={mutations.create.isPending} onClick={onClose}>关闭</Button>
        </header>
        <form onSubmit={submit}>
          <label>类型
            <Select
              autoFocus
              aria-label="新记忆类型"
              popupHost={() => dialogRef.current}
              value={type}
              onChange={(value) => setType(value as MemoryType)}
              options={memoryTypes.map((item) => ({ value: item, label: memoryTypeLabel(item) }))}
            />
            <small>{memoryTypeDescription(type)}</small>
          </label>
          <label>标题
            <input aria-label="新记忆标题" maxLength={160} value={title} placeholder="一句话概括这条记忆" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>内容
            <textarea aria-label="新记忆内容" rows={5} maxLength={8000} value={content} placeholder="写成脱离当前对话也能独立理解的完整陈述" onChange={(event) => setContent(event.target.value)} />
          </label>
          {error && <ErrorText role="alert">{error}</ErrorText>}
          <Actions>
            <Button type="button" disabled={mutations.create.isPending} onClick={onClose}>取消</Button>
            <Button $primary type="submit" disabled={mutations.create.isPending || !title.trim() || !content.trim()}>
              {mutations.create.isPending ? '保存中…' : '保存为已确认'}
            </Button>
          </Actions>
        </form>
      </Dialog>
    </Overlay>
  );
}
