import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BugReviewWorkspace, type ReviewSection } from '@/features/bug-review/BugReviewWorkspace';

export function BugReview() {
  const {section,reviewId} = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return <BugReviewWorkspace section={section==='library'?'library':'review'} selectedId={reviewId} query={params.get('q') || ''}
    onNavigate={(next:ReviewSection,id,q)=>navigate(`/bug-review/${next}${id?'/'+encodeURIComponent(id):''}${q?'?q='+encodeURIComponent(q):''}`)}/>;
}
