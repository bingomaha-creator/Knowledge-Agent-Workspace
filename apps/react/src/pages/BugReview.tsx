import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { BugReviewWorkspace, type ReviewSection, type ReviewView } from '@/features/bug-review/BugReviewWorkspace';

export function BugReview() {
  const {section,reviewId} = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value:boolean)=>{dirty.current=value;},[]);
  const blocker = useBlocker(()=>dirty.current && !window.confirm('有未保存修改，是否放弃修改并离开？'));
  useEffect(()=>{if(blocker.state==='blocked')blocker.reset();},[blocker]);
  const requestedView = params.get('view');
  return <BugReviewWorkspace section={section==='review'?'review':'library'} selectedId={reviewId} query={params.get('q') || ''}
    view={requestedView==='edit'||requestedView==='draft'?requestedView:undefined}
    onDirtyChange={onDirtyChange}
    onNavigate={(next:ReviewSection,id,q,view?:ReviewView)=>{
      const search = new URLSearchParams();
      if(q)search.set('q',q);
      if(view)search.set('view',view);
      navigate(`/bug-review/${next}${id?'/'+encodeURIComponent(id):''}${search.size?'?'+search.toString():''}`);
    }}/>
}
