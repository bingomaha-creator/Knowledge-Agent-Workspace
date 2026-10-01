import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import styled from 'styled-components';
import { bugReviewApi, type BugReview, type ReviewDocument, type ReviewMaterial, type ReviewOperation } from '@/services/bugReviewApi';
import { Button } from '@/ui/Button';
import { Feedback } from '@/ui/Feedback';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';

export type ReviewSection = 'review' | 'library';
type Props = {section:ReviewSection; selectedId?:string; query:string; onNavigate:(section:ReviewSection,id?:string,query?:string)=>void};
const Root = styled.div`display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;overflow:hidden;`;
const Pane = styled.div`height:100%;min-width:0;overflow:auto;padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-4);`;
const Controls = styled.div`display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;`;
const Form = styled.form`display:flex;flex-direction:column;gap:var(--space-3);`;
const Label = styled.label`display:flex;flex-direction:column;gap:var(--space-2);color:var(--color-text);font-size:.875rem;min-width:0;`;
const Input = styled.input`width:100%;min-width:0;padding:.65rem;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);`;
const Textarea = styled.textarea`width:100%;min-height:6rem;resize:vertical;padding:.65rem;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);line-height:1.6;`;
const Select = styled.select`padding:.65rem;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);`;
const Card = styled.div`padding:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);overflow-wrap:anywhere;`;
const RecordButton = styled.button<{$selected:boolean}>`width:100%;text-align:left;padding:var(--space-3);border:1px solid ${({$selected})=>$selected?'var(--color-primary)':'var(--color-border)'};border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);overflow-wrap:anywhere;line-height:1.5;`;
const Subtle = styled.p`margin:0;color:var(--color-text-muted);font-size:.8rem;line-height:1.6;overflow-wrap:anywhere;`;
const Text = styled.p`white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;`;
const Code = styled.pre`max-width:100%;max-height:24rem;overflow:auto;font-size:.75rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;`;
const Heading = styled.h2`margin:0 0 var(--space-3);font-size:1rem;`;
const fieldLabels:Record<string,string> = {title:'标题',symptom:'问题现象',root_cause:'根因与来源',impact:'影响评估',fix_solution:'修复方案',prevention:'规避措施',validation:'验证依据',human_notes:'人工补充',keywords:'关键词',gaps:'缺口说明',completeness:'证据完整性'};
const statusText:Record<string,string> = {draft:'草稿',pending:'待审核',approved:'已通过，待发布',rejected:'已驳回',published:'已发布',queued:'等待执行',collecting:'采集 PR 材料',generating:'Qwen 生成中',completed:'任务完成',failed:'任务失败'};
const active = (review?:BugReview) => review && ['queued','collecting','generating'].includes(review.task.status);

function Quality({document}:{document:ReviewDocument}) {
  return <Card><Heading>{document.completeness === 'complete' ? '证据完整' : '证据不完整'}</Heading>
    {document.human_edits?.length ? <Subtle>人工修订字段：{document.human_edits.map(field=>fieldLabels[field] || '补充内容').join('、')}</Subtle> : null}<Subtle>完整性与审核状态独立；可追溯引用不代表根因已经过事实核验。</Subtle>
    {document.gaps.length > 0 && <ul>{document.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul>}
  </Card>;
}
function Material({material}:{material:ReviewMaterial|null}) {
  if (!material) return null;
  return <details><summary>查看采集材料、diff 与来源（{material.sources.length}）</summary>
    <Subtle>采集时间：{material.collected_at || '未提供'} · Head：{material.head_sha || '未提供'}</Subtle>
    {[...material.gaps,...(material.model_gaps || [])].map((gap,index)=><Subtle key={index}>{gap}</Subtle>)}
    {material.sources.map(source=><Card key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.id} · {source.type}</a><Code>{source.text || '无内容'}</Code></Card>)}
  </details>;
}
function DocumentView({document}:{document:ReviewDocument}) {
  return <><Heading>{document.title}</Heading><Quality document={document}/>
    {([['问题现象',document.symptom],['根因',document.root_cause.content],['修复方案',document.fix_solution],['规避措施',document.prevention],['验证依据',document.validation],['人工补充',document.human_notes]] as const).map(([title,value])=><Card key={title}><Heading>{title}</Heading><Text>{value || '未提供'}</Text></Card>)}
    <Subtle>根因依据：{({fact:'材料事实',inference:'模型推断',human:'人工补充'} as const)[document.root_cause.basis]}</Subtle>
    {[document.root_cause.source,...document.source_refs].filter(ref=>ref.source_id).map((ref,index)=><Card key={index}><a href={ref.url} target="_blank" rel="noreferrer">来源：{ref.source_id}</a><Text>{ref.snippet}</Text></Card>)}
  </>;
}
function Editor({review, busy, onAction}:{review:BugReview;busy:boolean;onAction:(op:ReviewOperation,doc?:ReviewDocument,notes?:string)=>void}) {
  const [document,setDocument] = useState(review.document!);
  const [notes,setNotes] = useState('');
  const dirty = JSON.stringify(document) !== JSON.stringify(review.document);
  const disabled = busy || !!active(review);
  const field = (key:'title'|'symptom'|'fix_solution'|'prevention'|'validation'|'human_notes',title:string) => <Label key={key}>{title}
    {key === 'title' ? <Input value={document[key] || ''} disabled={disabled} onChange={e=>setDocument({...document,[key]:e.target.value})}/> :
      <Textarea value={document[key] || ''} disabled={disabled} onChange={e=>setDocument({...document,[key]:e.target.value})}/>}
  </Label>;
  return <><Quality document={document}/><Form onSubmit={e=>{e.preventDefault();onAction('edit',document);}}>
    {field('title','标题')}{field('symptom','问题现象')}
    <Label>根因<Textarea value={document.root_cause.content} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,content:e.target.value}})}/></Label>
    <Label>根因依据<Select value={document.root_cause.basis} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,basis:e.target.value as ReviewDocument['root_cause']['basis']}})}><option value="fact">材料事实</option><option value="inference">推断，待确认</option><option value="human">人工补充</option></Select></Label>
    {document.root_cause.source.source_id && <Card><a href={document.root_cause.source.url} target="_blank" rel="noreferrer">根因来源：{document.root_cause.source.source_id}</a><Text>{document.root_cause.source.snippet}</Text></Card>}
    <Label>根因来源<Select value={document.root_cause.source.location || ''} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,source:{location:e.target.value,snippet:''}}})}><option value="">尚未绑定来源</option>{(review.document_material || review.material)?.sources.map(source=><option key={source.id} value={source.id}>{source.id}</option>)}</Select></Label>
    <Label>根因原文引用<Textarea value={document.root_cause.source.snippet || ''} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,source:{...document.root_cause.source,snippet:e.target.value}}})}/></Label>
    {field('fix_solution','修复方案')}{field('prevention','规避措施')}{field('validation','验证依据')}{field('human_notes','人工补充背景')}
    <Label>关键词（逗号分隔）<Input value={document.keywords.join(', ')} disabled={disabled} onChange={e=>setDocument({...document,keywords:e.target.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)})}/></Label>
    <Label>证据完整性<Select value={document.completeness} disabled={disabled} onChange={e=>setDocument({...document,completeness:e.target.value as ReviewDocument['completeness']})}><option value="incomplete">证据不完整</option><option value="complete">证据完整（由审核者判断）</option></Select></Label>
    <Label>缺口说明（一行一项）<Textarea value={document.gaps.join('\n')} disabled={disabled} onChange={e=>setDocument({...document,gaps:e.target.value.split('\n').filter(Boolean)})}/></Label>
    <Button type="submit" variant="primary" disabled={disabled || !dirty}>保存草稿</Button>
  </Form>
  {dirty && <Feedback role="status">有未保存修改，请先保存；保存后需重新审核。</Feedback>}
  <Label>审核备注 / 驳回原因<Textarea value={notes} disabled={disabled} onChange={e=>setNotes(e.target.value)}/></Label>
  <Controls>
    {review.task.error && <Button disabled={disabled || dirty} onClick={()=>onAction('retry')}>重试采集与生成</Button>}
    <Button disabled={disabled || dirty || !['draft','rejected','pending'].includes(review.status)} onClick={()=>onAction('approve',undefined,notes)}>审核通过</Button>
    <Button variant="danger" disabled={disabled || dirty || !notes.trim() || review.status === 'published'} onClick={()=>onAction('reject',undefined,notes)}>驳回</Button>
    <Button variant="primary" disabled={disabled || dirty || review.status !== 'approved'} onClick={()=>onAction('publish')}>发布到案例库</Button>
    <Button disabled={disabled || dirty} onClick={()=>onAction('refresh')}>重新获取材料</Button>
    <Button disabled={disabled || dirty} onClick={()=>onAction('regenerate')}>重新生成</Button>
  </Controls>
  {review.candidate && <Card><Heading>新的生成结果（尚未采用）</Heading><DocumentView document={review.candidate}/><Controls><Button disabled={disabled || dirty} onClick={()=>onAction('adopt')}>采用新结果</Button><Button disabled={disabled || dirty} onClick={()=>onAction('discard')}>丢弃新结果</Button></Controls></Card>}
  <Material material={review.material}/>
  <details><summary>审核记录（{review.history.length}）</summary>{review.history.map((entry,index)=><Subtle key={index}>{entry.created_at} · {entry.action} · {entry.reviewer} · {entry.notes}</Subtle>)}</details>
  </>;
}

export function BugReviewWorkspace({section,selectedId,query,onNavigate}:Props) {
  const client = useQueryClient();
  const [url,setUrl] = useState('');
  const [search,setSearch] = useState(query);
  useEffect(()=>setSearch(query),[query]);
  const [notice,setNotice] = useState('');
  const list = useQuery({queryKey:['bug-review','reviews'],queryFn:bugReviewApi.list,refetchInterval:q=>q.state.data?.some(record=>['queued','collecting','generating'].includes(record.task.status)) ? 2000 : false});
  const library = useQuery({queryKey:['bug-review','library',query],queryFn:()=>bugReviewApi.library(query),enabled:section === 'library'});
  const detail = useQuery({queryKey:['bug-review','detail',selectedId],queryFn:()=>bugReviewApi.get(selectedId!),enabled:!!selectedId && section === 'review',refetchInterval:q=>active(q.state.data) ? 1500 : false});
  const published = useQuery({queryKey:['bug-review','published',selectedId],queryFn:()=>bugReviewApi.published(selectedId!),enabled:!!selectedId && section === 'library'});
  const importing = useMutation({mutationFn:bugReviewApi.import,onSuccess:async result=>{setNotice(result.existing?'已打开该 PR 的现有复盘，未重复调用模型。':'已开始采集与生成。');onNavigate('review',result.review.id);await client.invalidateQueries({queryKey:['bug-review']});}});
  const action = useMutation({mutationFn:({op,doc,notes}:{op:ReviewOperation;doc?:ReviewDocument;notes?:string})=>bugReviewApi.action(selectedId!,op,{revision:detail.data!.revision,document:doc,notes}),onSuccess:async()=>{setNotice('操作已保存。');await client.invalidateQueries({queryKey:['bug-review']});}});
  const review = detail.data;
  const records = section === 'review' ? list.data : library.data;
  const error = importing.error || action.error || (section === 'review' ? detail.error || list.error : published.error || library.error);
  return <Root>
    <FeatureHeader title="Bug 修复经验沉淀" description="导入已合入的 PR，整理修复经验，审核后发布。" actions={<Controls><Button aria-pressed={section==='review'} onClick={()=>onNavigate('review')}>导入与审核</Button><Button aria-pressed={section==='library'} onClick={()=>onNavigate('library')}>案例库</Button></Controls>}/>
    {notice && <Feedback role="status">{notice}</Feedback>}
    {error && <Feedback tone="danger" role="alert" action={<button onClick={()=>{void client.invalidateQueries({queryKey:['bug-review']});importing.reset();action.reset();}}>重试加载</button>}>{error.message}</Feedback>}
    <MasterDetailLayout mobilePane={selectedId?'detail':'master'} masterLabel="复盘列表" detailLabel="复盘详情" master={<Pane>
      {section === 'review' ? <Form onSubmit={e=>{e.preventDefault();importing.mutate(url);}}><Label>GitHub PR 链接<Input type="url" required placeholder="https://github.com/owner/repo/pull/123" value={url} onChange={e=>setUrl(e.target.value)}/></Label><Button type="submit" variant="primary" disabled={importing.isPending}>{importing.isPending?'正在导入…':'导入已合入 PR'}</Button><Subtle>公开与有权限的私有仓库；采集材料由现有 Qwen 生成草稿。</Subtle></Form> :
        <Form onSubmit={e=>{e.preventDefault();onNavigate('library',undefined,search);}}><Label>搜索修复经验<Input value={search} onChange={e=>setSearch(e.target.value)} /></Label><Button type="submit">搜索案例</Button><Subtle>只搜索已发布快照，包含证据不完整案例。</Subtle></Form>}
      {(section === 'review' ? list.isPending : library.isPending) && <Subtle role="status">加载列表…</Subtle>}
      {records?.length === 0 && <Subtle>暂无{section==='review'?'复盘':'已发布案例'}。</Subtle>}
      {records?.map(record=><RecordButton key={record.id} $selected={record.id===selectedId} onClick={()=>onNavigate(section,record.id,query)}>{'title' in record ? record.title : record.document.title}<Subtle as="span"> · {record.identity.owner}/{record.identity.repo} #{record.identity.number}</Subtle><br/>{'task' in record ? statusText[record.task.status]+ ' · '+statusText[record.status] : (record.document.completeness==='complete'?'证据完整':'证据不完整')}</RecordButton>)}
    </Pane>} detail={<Pane>
      {selectedId && <Controls><Button onClick={()=>onNavigate(section,undefined,query)}>返回列表</Button>{section==='review' && review?.published && <Button onClick={()=>onNavigate('library',selectedId)}>查看已发布快照</Button>}</Controls>}
      {!selectedId && <Card><Heading>把修复变成可复用的经验</Heading><Text>提交一个已合入的 GitHub PR。系统会保存真实 diff 和讨论材料，并生成带来源的复盘草稿；根因不足时保留待确认说明。</Text></Card>}
      {selectedId && (section==='review'?detail.isPending:published.isPending) && <Subtle role="status">加载详情…</Subtle>}
      {section==='review' && review && <><a href={review.identity.url} target="_blank" rel="noreferrer">{review.identity.url}</a><Subtle role="status">{statusText[review.task.status]} · {statusText[review.status]}</Subtle>
        {review.task.error && <Feedback role="alert" tone="danger">{review.task.error.message}{!review.document && <><Button disabled={action.isPending} onClick={()=>action.mutate({op:'retry'})}>重试采集与生成</Button>{review.material && <Button disabled={action.isPending} onClick={()=>action.mutate({op:'regenerate'})}>使用已有材料重新生成</Button>}</>}</Feedback>}
        {review.document && <Editor key={`${review.id}:${review.revision}`} review={review} busy={action.isPending} onAction={(op,doc,notes)=>action.mutate({op,doc,notes})}/>}
        {!review.document && <Material material={review.material}/>}</>}
      {section==='library' && published.data && <><a href={published.data.identity.url} target="_blank" rel="noreferrer">来源 PR</a><Subtle>发布时间：{published.data.published_at}</Subtle><DocumentView document={published.data.document}/><Material material={published.data.material}/><Button onClick={()=>onNavigate('review',selectedId)}>查看审核工作稿</Button></>}
    </Pane>}/>
  </Root>;
}
