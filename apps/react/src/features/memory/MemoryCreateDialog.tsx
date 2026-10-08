import { useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import type { MemoryRecord, MemoryType } from '@/services/memoryApi';
import { Select } from 'matthew-ui/select';
import { Dialog } from 'matthew-ui/dialog';
import 'matthew-ui/select/style.css';
import 'matthew-ui/dialog/style.css';
import { memoryTypeDescription, memoryTypeLabel, memoryTypes } from './memoryDisplay';
import { useMemoryMutations } from './useMemoryMutations';

const Form = styled.form`
  display: grid;
  min-width: 0;
  gap: var(--space-4);
  label { display: grid; min-width: 0; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }
  input, textarea { width: 100%; min-width: 0; padding: 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-text); background: var(--color-background); font: inherit; }
  small { color: var(--color-text-subtle); }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
`;

const Button = styled.button<{ $primary?: boolean }>`
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: ${({ $primary }) => $primary ? 'var(--color-text-on-primary)' : 'var(--color-text)'};
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
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (memory: MemoryRecord) => void;
}) {
  const mutations = useMemoryMutations();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const typeRef = useRef<HTMLButtonElement>(null);
  const [type, setType] = useState<MemoryType>('fact');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

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
    <Dialog
      ref={dialogRef}
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen && !mutations.create.isPending) onClose(); }}
      title="新建长期记忆"
      closeLabel="关闭新建记忆"
      dismissible={!mutations.create.isPending}
      initialFocus={() => typeRef.current}
    >
      <Form onSubmit={submit}>
        <label>类型
          <Select
            ref={typeRef}
            aria-label="新记忆类型"
            popupHost={() => dialogRef.current}
            value={type}
            onValueChange={(value) => setType(value as MemoryType)}
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
      </Form>
    </Dialog>
  );
}
