import { useEffect, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import type { MemoryRecord, MemoryType } from '@/services/memoryApi';
import { memoryStatusLabel, memoryTypeLabel, memoryTypes } from './memoryDisplay';
import { useMemoryDetail } from './memoryQueries';
import { useMemoryMutations } from './useMemoryMutations';

const Pane = styled.article`
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--color-surface);
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  h2 { margin: 0; overflow-wrap: anywhere; font-size: 1.05rem; }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
`;

const Button = styled.button<{ $primary?: boolean; $danger?: boolean }>`
  padding: 0.55rem 0.75rem;
  border: 1px solid ${({ $danger }) => $danger ? 'var(--color-danger)' : 'var(--color-border)'};
  border-radius: var(--radius-md);
  color: ${({ $primary, $danger }) => $primary ? 'white' : $danger ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
  &:disabled { opacity: 0.55; }
`;

const BackButton = styled(Button)`
  display: none;
  @media (max-width: 48rem) { display: inline-block; }
`;

const Body = styled.div`
  min-height: 0;
  flex: 1;
  padding: var(--space-6);
  overflow-y: auto;
  h3 { margin: var(--space-6) 0 var(--space-2); font-size: 0.8rem; }
  p { max-width: 60rem; margin: 0; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
  pre { max-width: 60rem; padding: var(--space-4); overflow: auto; border-radius: var(--radius-md); background: var(--color-background); font: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  span { padding: 0.3rem 0.55rem; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-muted); font-size: 0.75rem; }
`;

const State = styled.div`
  display: grid;
  height: 100%;
  min-height: 16rem;
  padding: var(--space-6);
  place-content: center;
  color: var(--color-text-muted);
  text-align: center;
`;

const Form = styled.form`
  display: grid;
  max-width: 50rem;
  gap: var(--space-4);
  label { display: grid; gap: var(--space-2); color: var(--color-text-muted); font-size: 0.75rem; }
  input, textarea, select { width: 100%; padding: 0.7rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); background: var(--color-background); font: inherit; }
`;

type Props = {
  memoryId?: string;
  onClose: () => void;
  onChanged: (memory: MemoryRecord) => void;
  onDeleted: () => void;
  onOpenSource: (conversationId: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

export function MemoryDetail({ memoryId, onClose, onChanged, onDeleted, onOpenSource, onNotice, onError }: Props) {
  const detail = useMemoryDetail(memoryId);
  const mutations = useMemoryMutations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ type: 'fact' as MemoryType, title: '', content: '', confidence: 0.5 });

  useEffect(() => {
    setEditing(false);
  }, [memoryId]);

  if (!memoryId) return <State>从左侧选择一条记忆查看详情。</State>;
  if (detail.isLoading) return <State>正在加载记忆详情…</State>;
  if (detail.isError || !detail.data) return <State><strong>无法加载记忆详情</strong><br />{detail.error instanceof Error ? detail.error.message : '记忆可能已被删除。'}<br /><Button onClick={onClose}>返回列表</Button></State>;
  const memory = detail.data;
  const busy = mutations.update.isPending || mutations.remove.isPending;

  function startEdit() {
    setDraft({ type: memory.type, title: memory.title, content: memory.content, confidence: memory.confidence });
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim() || !draft.content.trim()) return;
    try {
      const updated = await mutations.update.mutateAsync({
        id: memory.id,
        patch: { ...draft, title: draft.title.trim(), content: draft.content.trim(), status: 'corrected' }
      });
      setEditing(false); onChanged(updated); onNotice('记忆已纠正。');
    } catch (error) { onError(error instanceof Error ? error.message : '更新长期记忆失败'); }
  }

  async function review(status: 'confirmed' | 'rejected') {
    try {
      const updated = await mutations.update.mutateAsync({ id: memory.id, patch: { status } });
      onChanged(updated); onNotice(status === 'confirmed' ? '记忆已确认。' : '记忆候选已拒绝。');
    } catch (error) { onError(error instanceof Error ? error.message : '更新长期记忆失败'); }
  }

  async function remove() {
    if (!window.confirm(`永久删除记忆“${memory.title}”？历史对话中的候选卡片也会移除。`)) return;
    try {
      await mutations.remove.mutateAsync(memory.id);
      onDeleted(); onNotice('记忆已永久删除。');
    } catch (error) { onError(error instanceof Error ? error.message : '删除长期记忆失败'); }
  }

  return (
    <Pane>
      <Header>
        <div><BackButton onClick={onClose}>返回记忆列表</BackButton><h2>{memory.title}</h2></div>
        {!editing && <Actions>
          {memory.status === 'candidate' && <><Button $primary disabled={busy} onClick={() => review('confirmed')}>确认</Button><Button disabled={busy} onClick={() => review('rejected')}>拒绝</Button></>}
          <Button disabled={busy} onClick={startEdit}>编辑</Button>
          <Button $danger disabled={busy} onClick={remove}>永久删除</Button>
        </Actions>}
      </Header>
      <Body>
        {editing ? (
          <Form onSubmit={save}>
            <label>类型<select aria-label="记忆类型" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as MemoryType }))}>{memoryTypes.map((type) => <option key={type} value={type}>{memoryTypeLabel(type)}</option>)}</select></label>
            <label>标题<input aria-label="记忆标题" maxLength={160} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
            <label>内容<textarea aria-label="记忆内容" rows={8} maxLength={8000} value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></label>
            <label>置信度 {Math.round(draft.confidence * 100)}%<input aria-label="记忆置信度" type="range" min="0" max="1" step="0.05" value={draft.confidence} onChange={(event) => setDraft((current) => ({ ...current, confidence: Number(event.target.value) }))} /></label>
            <Actions><Button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</Button><Button $primary type="submit" disabled={busy || !draft.title.trim() || !draft.content.trim()}>保存纠正</Button></Actions>
          </Form>
        ) : (
          <>
            <Meta><span>{memoryTypeLabel(memory.type)}</span><span>{memoryStatusLabel(memory.status)}</span><span>置信度 {Math.round(memory.confidence * 100)}%</span></Meta>
            <h3>记忆内容</h3><p>{memory.content}</p>
            <h3>时间</h3><p>更新于 {new Date(memory.updatedAt).toLocaleString()}{memory.confirmedAt ? ` · 确认于 ${new Date(memory.confirmedAt).toLocaleString()}` : ''}</p>
            {memory.sourceExcerpt && <><h3>来源{memory.sourceExcerptTruncated ? '（片段已截断）' : ''}</h3><pre>{memory.sourceExcerpt}</pre></>}
            {memory.sourceConversationId && <Actions><Button onClick={() => onOpenSource(memory.sourceConversationId)}>打开来源会话</Button></Actions>}
          </>
        )}
      </Body>
    </Pane>
  );
}
