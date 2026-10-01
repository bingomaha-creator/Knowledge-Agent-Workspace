import { useEffect, useRef, useState } from 'react';
import { replaceEqualDeep, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import styled from 'styled-components';
import { bugReviewApi, type BugReview, type ReviewDocument, type ReviewMaterial, type ReviewOperation, type ReviewSource } from '@/services/bugReviewApi';
import { Button } from '@/ui/Button';
import { Feedback } from '@/ui/Feedback';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';

export type ReviewSection = 'review' | 'library';
export type ReviewView = 'draft' | 'edit';
type Props = {section:ReviewSection; selectedId?:string; query:string; view?:ReviewView; onDirtyChange?:(dirty:boolean)=>void; onNavigate:(section:ReviewSection,id?:string,query?:string,view?:ReviewView)=>void};
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
const Article = styled.article`background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-card);padding:var(--space-5);min-width:0;`;
const Chapter = styled.section`padding:var(--space-4) 0;border-bottom:1px solid var(--color-border);&:first-child{padding-top:0;}&:last-child{border-bottom:0;padding-bottom:0;}`;
const ChapterTitle = styled.h3`margin:0;font-size:.95rem;line-height:1.5;`;
const Details = styled.details`min-width:0;summary{cursor:pointer;line-height:1.6;color:var(--color-text-muted);font-size:.85rem;} &[open]>summary{margin-bottom:var(--space-3);}`;
const ReadingTitle = styled.h2`margin:0;font-size:1.25rem;line-height:1.5;overflow-wrap:anywhere;`;
const EditorControls = styled(Controls)`position:sticky;top:0;z-index:1;background:var(--color-surface);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-control);`;
const fieldLabels:Record<string,string> = {title:'标题',symptom:'问题现象',root_cause:'根因与来源',impact:'影响评估',fix_solution:'修复方案',prevention:'规避措施',validation:'验证依据',human_notes:'人工补充',keywords:'关键词',gaps:'缺口说明',completeness:'证据完整性'};
const statusText:Record<string,string> = {draft:'草稿',pending:'待审核',approved:'已通过，待发布',rejected:'已驳回',published:'已发布',queued:'等待执行',collecting:'采集 PR 材料',generating:'Qwen 生成中',completed:'任务完成',failed:'任务失败'};
const active = (review?:BugReview) => review && ['queued','collecting','generating'].includes(review.task.status);

function hasUnpublishedChanges(review:BugReview) {
  if (!review.document || !review.published) return false;
  // Review status and edit history describe the workflow, not the case content.
  const content = (document:ReviewDocument) => Object.fromEntries(Object.entries(document).filter(([key])=>key!=='review_status' && key!=='human_edits'));
  const draft = content(review.document);
  return replaceEqualDeep(draft,content(review.published.document)) !== draft;
}
function UnpublishedChanges({review,error,checking,onOpen}:{review?:BugReview;error?:Error|null;checking:boolean;onOpen:()=>void}) {
  if (error) return <Subtle>暂时无法核对未发布修改</Subtle>;
  if (checking || !review) return <Subtle>正在核对未发布修改…</Subtle>;
  return hasUnpublishedChanges(review) ? <Button onClick={onOpen}>查看未发布修改</Button> : <Subtle>当前没有未发布修改</Subtle>;
}

function Quality({document}:{document:ReviewDocument}) {
  return <Details><summary>证据缺口与人工修订记录（{document.gaps.length}）</summary>
    {document.human_edits?.length ? <Subtle>人工修订字段：{document.human_edits.map(field=>fieldLabels[field] || '补充内容').join('、')}</Subtle> : null}<Subtle>完整性与审核状态独立；可追溯引用不代表根因已经过事实核验。</Subtle>
    {document.gaps.length > 0 && <ul>{document.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul>}
  </Details>;
}
function sourceName(reference:ReviewSource, material?:ReviewMaterial|null) {
  const source = material?.sources.find(item=>item.id===(reference.source_id || reference.location));
  const names:Record<string,string> = {pr_body:'PR 描述',diff:'代码变更',pr_comment:'PR 讨论',commit_message:'提交说明',issue:'关联 Issue',ci:'CI 状态'};
  if (!source) return names[reference.type || ''] || '来源原文';
  const group = source.id.split(':')[0];
  if (['comments','reviews','inline'].includes(group)) {
    const labels:Record<string,string> = {comments:'PR 评论',reviews:'代码评审',inline:'行内评论'};
    const ordinal = material!.sources.filter(item=>item.id.startsWith(group+':')).findIndex(item=>item.id===source.id)+1;
    return labels[group]+' '+ordinal+(group==='inline'?' · '+source.text.split('\n')[0]:'');
  }
  const title = source.text.split('\n')[0].slice(0,80);
  return (names[source.type] || '来源原文') + (['diff','commit_message','issue'].includes(source.type)?' · '+title:'');
}
function Citation({reference,material,label}:{reference:ReviewSource;material?:ReviewMaterial|null;label:string}) {
  if (!reference.source_id) return null;
  return <Details><summary>{label} · {sourceName(reference,material)}</summary>
    <a href={reference.url} target="_blank" rel="noreferrer">打开来源</a><Code>{reference.snippet}</Code>
  </Details>;
}
function Material({material}:{material:ReviewMaterial|null}) {
  if (!material) return null;
  return <details><summary>查看采集材料、diff 与来源（{material.sources.length}）</summary>
    <Subtle>采集时间：{material.collected_at || '未提供'} · Head：{material.head_sha || '未提供'}</Subtle>
    {[...material.gaps,...(material.model_gaps || [])].map((gap,index)=><Subtle key={index}>{gap}</Subtle>)}
    {material.sources.map(source=><Card key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{sourceName({source_id:source.id},material)}</a><Code>{source.text || '无内容'}</Code></Card>)}
  </details>;
}
function DocumentView({document,material}:{document:ReviewDocument;material?:ReviewMaterial|null}) {
  return <><Article aria-label="复盘正文">
    {([['问题现象',document.symptom],['根因',document.root_cause.content],['修复方案',document.fix_solution],['验证依据',document.validation],['规避措施',document.prevention]] as const).map(([title,value])=><Chapter key={title}><ChapterTitle>{title}</ChapterTitle><Text>{value || '未提供'}</Text>
      {title==='根因' && <><Subtle>判断依据：{({fact:'材料事实（仍需核对）',inference:'推断，待确认',human:'人工补充'} as const)[document.root_cause.basis]}</Subtle><Citation reference={document.root_cause.source} material={material} label="查看根因依据"/></>}
    </Chapter>)}
    {document.human_notes && <Chapter><ChapterTitle>人工补充</ChapterTitle><Text>{document.human_notes}</Text></Chapter>}
  </Article><Quality document={document}/>
    {document.source_refs.some(ref=>ref.source_id) && <Details><summary>其他引用</summary>{document.source_refs.map((reference,index)=><Citation key={index} reference={reference} material={material} label="查看引用"/>)}</Details>}
  </>;
}
function Editor({review, busy, onSave, onCancel, onDirtyChange}:{review:BugReview;busy:boolean;onSave:(doc:ReviewDocument)=>void;onCancel:()=>void;onDirtyChange?:(dirty:boolean)=>void}) {
  const [document,setDocument] = useState(review.document!);
  const material = review.document_material || review.material;
  const selectedSource = material?.sources.find(source=>source.id===(document.root_cause.source.location || document.root_cause.source.source_id));
  const dirty = JSON.stringify(document) !== JSON.stringify(review.document);
  useEffect(()=>{onDirtyChange?.(dirty);return ()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
  const disabled = busy || !!active(review);
  const field = (key:'title'|'symptom'|'fix_solution'|'prevention'|'validation'|'human_notes',title:string) => <Label key={key}>{title}
    {key === 'title' ? <Input value={document[key] || ''} disabled={disabled} onChange={e=>setDocument({...document,[key]:e.target.value})}/> :
      <Textarea value={document[key] || ''} disabled={disabled} onChange={e=>setDocument({...document,[key]:e.target.value})}/>}
  </Label>;
  return <Form onSubmit={e=>{e.preventDefault();onSave(document);}}>
    <EditorControls><Button type="submit" variant="primary" disabled={disabled || !dirty}>保存草稿</Button><Button disabled={disabled} onClick={onCancel}>{dirty?'放弃修改，返回阅读':'返回阅读'}</Button></EditorControls>
    {dirty && <Feedback role="status">有未保存修改；保存后需重新审核，已发布版本保持不变。</Feedback>}
    {field('title','标题')}{field('symptom','问题现象')}
    <Label>根因<Textarea value={document.root_cause.content} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,content:e.target.value}})}/></Label>
    <Details><summary>编辑根因依据与原文引用</summary>
    <Label>根因依据<Select value={document.root_cause.basis} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,basis:e.target.value as ReviewDocument['root_cause']['basis']}})}><option value="fact">材料事实</option><option value="inference">推断，待确认</option><option value="human">人工补充</option></Select></Label>
    <Label>根因来源<Select value={document.root_cause.source.location || document.root_cause.source.source_id || ''} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,source:{location:e.target.value,snippet:''}}})}><option value="">尚未绑定来源</option>{(review.document_material || review.material)?.sources.map(source=><option key={source.id} value={source.id}>{sourceName({source_id:source.id},review.document_material || review.material)}</option>)}</Select></Label>
    {selectedSource && <Details><summary>查看所选来源原文</summary><a href={selectedSource.url} target="_blank" rel="noreferrer">打开来源</a><Code>{selectedSource.text}</Code></Details>}
    <Label>根因原文引用<Textarea value={document.root_cause.source.snippet || ''} disabled={disabled} onChange={e=>setDocument({...document,root_cause:{...document.root_cause,source:{...document.root_cause.source,snippet:e.target.value}}})}/></Label>
    </Details>
    {field('fix_solution','修复方案')}{field('prevention','规避措施')}{field('validation','验证依据')}{field('human_notes','人工补充背景')}
    <Label>关键词（逗号分隔）<Input value={document.keywords.join(', ')} disabled={disabled} onChange={e=>setDocument({...document,keywords:e.target.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)})}/></Label>
    <Label>证据完整性<Select value={document.completeness} disabled={disabled} onChange={e=>setDocument({...document,completeness:e.target.value as ReviewDocument['completeness']})}><option value="incomplete">证据不完整</option><option value="complete">证据完整（由审核者判断）</option></Select></Label>
    <Label>缺口说明（一行一项）<Textarea value={document.gaps.join('\n')} disabled={disabled} onChange={e=>setDocument({...document,gaps:e.target.value.split('\n').filter(Boolean)})}/></Label>
    <Quality document={document}/>
  </Form>;
}

export function BugReviewWorkspace({section,selectedId,query,view,onNavigate,onDirtyChange}:Props) {
  const client = useQueryClient();
  const selection = useRef({section,selectedId,view,query});
  selection.current = {section,selectedId,view,query};
  const [url,setUrl] = useState('');
  const [search,setSearch] = useState(query);
  useEffect(()=>setSearch(query),[query]);
  const [notice,setNotice] = useState('');
  const [notes,setNotes] = useState('');
  useEffect(()=>{setNotes('');setNotice('');},[selectedId,section]);
  const list = useQuery({queryKey:['bug-review','reviews'],queryFn:bugReviewApi.list,refetchInterval:q=>q.state.data?.some(record=>['queued','collecting','generating'].includes(record.task.status)) ? 2000 : false});
  const library = useQuery({queryKey:['bug-review','library',query],queryFn:()=>bugReviewApi.library(query),enabled:section === 'library'});
  const detail = useQuery({queryKey:['bug-review','detail',selectedId],queryFn:()=>bugReviewApi.get(selectedId!),enabled:!!selectedId,refetchInterval:q=>active(q.state.data) ? 1500 : false});
  const published = useQuery({queryKey:['bug-review','published',selectedId],queryFn:()=>bugReviewApi.published(selectedId!),enabled:!!selectedId && section === 'library'});
  const importing = useMutation({mutationFn:bugReviewApi.import,onSuccess:async result=>{setNotice(result.existing?'已打开该 PR 的现有复盘，未重复调用模型。':'已开始采集与生成。');onNavigate('review',result.review.id);await client.invalidateQueries({queryKey:['bug-review']});}});
  const action = useMutation({mutationFn:({id,revision,op,doc,notes}:{id:string;revision:number;op:ReviewOperation;doc?:ReviewDocument;notes?:string})=>bugReviewApi.action(id,op,{revision,document:doc,notes}),onMutate:()=>({...selection.current}),onSuccess:async(result,{op},origin)=>{
    client.setQueryData(['bug-review','detail',result.id],result);
    if(selection.current.selectedId===result.id && selection.current.section===origin.section && selection.current.view===origin.view && selection.current.query===origin.query) {
      setNotice(op==='edit'?'草稿已保存，需重新审核；已发布版本保持不变。':'操作已保存。');
      if(op==='edit'||op==='adopt'){onDirtyChange?.(false);onNavigate('review',result.id,query,'draft');}
      if(op==='publish')onNavigate('library',result.id,query);
    }
    await client.invalidateQueries({queryKey:['bug-review']});
  }});
  const review = detail.data;
  const editing = view==='edit' && !!review?.document && section==='review';
  const snapshot = view!=='draft' && !editing ? review?.published : null;
  const displayed = snapshot?.document || review?.document;
  const displayedMaterial = snapshot?.material || review?.document_material || review?.material;
  const actingOnSelection = action.variables?.id===selectedId;
  const disabled = (actingOnSelection && action.isPending) || !!active(review);
  const performAction = (op:ReviewOperation,doc?:ReviewDocument,notes?:string) => {if(review)action.mutate({id:review.id,revision:review.revision,op,doc,notes});};
  const records = section === 'review' ? list.data : library.data;
  const error = importing.error || (actingOnSelection ? action.error : null) || (section === 'review' ? detail.error || list.error : published.error || library.error);
  return <Root>
    <FeatureHeader title="Bug 修复经验沉淀" description="先阅读修复经验，需要修改时再编辑与审核。" actions={<Controls><Button aria-pressed={section==='library'} onClick={()=>onNavigate('library')}>案例库</Button><Button aria-pressed={section==='review'} onClick={()=>onNavigate('review')}>导入与审核</Button></Controls>}/>
    {notice && <Feedback role="status">{notice}</Feedback>}
    {error && <Feedback tone="danger" role="alert" action={<button onClick={()=>{void client.invalidateQueries({queryKey:['bug-review']});importing.reset();action.reset();}}>重试加载</button>}>{error.message}</Feedback>}
    <MasterDetailLayout mobilePane={selectedId?'detail':'master'} masterLabel="复盘列表" detailLabel="复盘详情" master={<Pane>
      {section === 'review' ? <Form onSubmit={e=>{e.preventDefault();importing.mutate(url);}}><Label>GitHub PR 链接<Input type="url" required placeholder="https://github.com/owner/repo/pull/123" value={url} onChange={e=>setUrl(e.target.value)}/></Label><Button type="submit" variant="primary" disabled={importing.isPending}>{importing.isPending?'正在导入…':'导入已合入 PR'}</Button><Subtle>公开与有权限的私有仓库；采集材料由现有 Qwen 生成草稿。</Subtle></Form> :
        <Form onSubmit={e=>{e.preventDefault();onNavigate('library',undefined,search);}}><Label>搜索修复经验<Input value={search} onChange={e=>setSearch(e.target.value)} /></Label><Button type="submit">搜索案例</Button><Subtle>只搜索已发布快照，包含证据不完整案例。</Subtle></Form>}
      {(section === 'review' ? list.isPending : library.isPending) && <Subtle role="status">加载列表…</Subtle>}
      {records?.length === 0 && <Subtle>暂无{section==='review'?'复盘':'已发布案例'}。</Subtle>}
      {records?.map(record=><RecordButton key={record.id} $selected={record.id===selectedId} onClick={()=>onNavigate(section,record.id,query)}>{'title' in record ? record.title : record.document.title}<Subtle as="span"> · {record.identity.owner}/{record.identity.repo} #{record.identity.number}</Subtle><br/>{'task' in record ? statusText[record.task.status]+ ' · '+statusText[record.status] : (record.document.completeness==='complete'?'证据完整':'证据不完整')}</RecordButton>)}
    </Pane>} detail={<Pane>
      {selectedId && !editing && <Controls><Button onClick={()=>onNavigate(section,undefined,query)}>返回列表</Button></Controls>}
      {!selectedId && <Card><Heading>{section==='library'?'选择案例开始阅读':'导入一篇修复 PR'}</Heading><Text>{section==='library'?'左侧选择已发布案例，按问题现象、根因、修复方案和验证依据阅读。需要修改时点击“编辑复盘”。':'提交已合入的 GitHub PR，生成后先阅读草稿，再编辑、审核和发布。'}</Text></Card>}
      {selectedId && (section==='review'?detail.isPending:published.isPending) && <Subtle role="status">加载详情…</Subtle>}
      {section==='review' && review && <>
        <Subtle><a href={review.identity.url} target="_blank" rel="noreferrer">{review.identity.owner}/{review.identity.repo} #{review.identity.number} · 来源 PR</a></Subtle>
        <ReadingTitle>{editing?'编辑复盘':displayed?.title || '正在整理复盘'}</ReadingTitle>
        <Subtle role="status">{editing?'正在编辑工作稿':snapshot?'已发布版本':'工作稿 · '+statusText[review.status]}{!editing && displayed?' · '+(displayed.completeness==='complete'?'证据完整':'证据不完整'):''}{active(review)?' · '+statusText[review.task.status]:''}</Subtle>
        {snapshot && <Subtle>发布于 {new Date(snapshot.published_at).toLocaleString('zh-CN',{hour12:false})}；工作稿的修改不会自动进入此版本。</Subtle>}
        {snapshot && hasUnpublishedChanges(review) && <Subtle>另有{statusText[review.status]}的工作稿，尚未替换已发布版本。</Subtle>}
        {review.task.error && <Feedback role="alert" tone="danger">{review.task.error.message}{!editing && <Button disabled={disabled} onClick={()=>performAction('retry')}>重试采集与生成</Button>}</Feedback>}
        {editing && <Editor key={`${review.id}:${review.revision}`} review={review} busy={actingOnSelection && action.isPending} onDirtyChange={onDirtyChange} onSave={doc=>performAction('edit',doc)} onCancel={()=>{onDirtyChange?.(false);action.reset();onNavigate('review',selectedId,query);}}/>}
        {!editing && displayed && <>
          <Controls><Button disabled={disabled} onClick={()=>onNavigate('review',selectedId,query,'edit')}>编辑复盘</Button>
            {snapshot && <UnpublishedChanges review={review} error={detail.error} checking={detail.isFetching} onOpen={()=>onNavigate('review',selectedId,query,'draft')}/>}
            {!snapshot && review.published && <Button onClick={()=>onNavigate('review',selectedId,query)}>查看已发布快照</Button>}
            {!snapshot && ['draft','rejected','pending'].includes(review.status) && <Button variant="primary" disabled={disabled} onClick={()=>performAction('approve',undefined,notes)}>审核通过</Button>}
            {!snapshot && review.status==='approved' && <Button variant="primary" disabled={disabled} onClick={()=>performAction('publish')}>发布到案例库</Button>}
          </Controls>
          {!snapshot && review.status!=='published' && <Details><summary>审核备注与驳回</summary><Label>审核备注 / 驳回原因<Textarea value={notes} disabled={disabled} onChange={e=>setNotes(e.target.value)}/></Label><Button variant="danger" disabled={disabled || !notes.trim()} onClick={()=>performAction('reject',undefined,notes)}>驳回</Button></Details>}
          <DocumentView document={displayed} material={displayedMaterial}/>
        </>}
        {!editing && <>
          {review.candidate && <Details><summary>新生成结果尚未采用 · {review.candidate.completeness==='complete'?'证据完整':'证据不完整'} · 查看候选</summary><Heading>{review.candidate.title}</Heading><DocumentView document={review.candidate} material={review.candidate_material}/><Controls><Button disabled={disabled} onClick={()=>performAction('adopt')}>采用新结果</Button><Button disabled={disabled} onClick={()=>performAction('discard')}>丢弃新结果</Button></Controls></Details>}
          <Material material={displayedMaterial || null}/>
          <Details><summary>材料更新与重新生成</summary><Subtle>重新生成的结果需要明确采用；当前工作稿和已发布版本不会自动覆盖。</Subtle><Controls><Button disabled={disabled} onClick={()=>performAction('refresh')}>重新获取材料</Button><Button disabled={disabled || !review.material} onClick={()=>performAction('regenerate')}>重新生成</Button></Controls><ChapterTitle>最新采集材料（用于重新生成）</ChapterTitle><Material material={review.material}/></Details>
          <Details><summary>审核记录（{review.history.length}）</summary>{review.history.map((entry,index)=><Subtle key={index}>{entry.created_at} · {entry.action} · {entry.reviewer} · {entry.notes}</Subtle>)}</Details>
        </>}
      </>}
      {section==='library' && published.data && <>
        <Subtle><a href={published.data.identity.url} target="_blank" rel="noreferrer">{published.data.identity.owner}/{published.data.identity.repo} #{published.data.identity.number} · 来源 PR</a></Subtle>
        <ReadingTitle>{published.data.document.title}</ReadingTitle><Subtle>已发布版本 · {published.data.document.completeness==='complete'?'证据完整':'证据不完整'} · {new Date(published.data.published_at).toLocaleString('zh-CN',{hour12:false})}</Subtle>
        <Controls><Button onClick={()=>onNavigate('review',selectedId,query,'edit')}>编辑复盘</Button><UnpublishedChanges review={review} error={detail.error || published.error} checking={detail.isFetching || published.isFetching} onOpen={()=>onNavigate('review',selectedId,query,'draft')}/></Controls>
        <DocumentView document={published.data.document} material={published.data.material}/><Material material={published.data.material}/>
      </>}
    </Pane>}/>
  </Root>;
}
