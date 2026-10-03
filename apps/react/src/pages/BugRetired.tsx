import { Navigate, useNavigate, useParams } from 'react-router';
import { Button } from '@/ui/Button';
import { Empty } from '@/ui/Empty';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { Panel } from '@/ui/Panel';

export function BugRetired() {
  const { section, recordId, '*': remainingPath } = useParams();
  const navigate = useNavigate();
  const reviewSection = section === 'review' || section === 'investigations';
  const knownList = !recordId && (!section || section === 'library' || reviewSection);
  const oldCreate = reviewSection && recordId === 'new';
  if (!remainingPath && (knownList || oldCreate)) {
    const target = section === 'library' ? '/bug-review/library' :
      reviewSection ? '/bug-review/review' : '/bug-review';
    return <Navigate replace to={target} />;
  }
  return <>
    <FeatureHeader title="旧版 Bug 工作区已退役" />
    <Panel><Empty title="此链接指向旧版调查或案例"
      description="旧记录保留在本地，不会自动迁入新的 PR 复盘。"
      action={<Button onClick={() => navigate('/bug-review')}>进入 Bug 复盘</Button>} />
    </Panel>
  </>;
}
