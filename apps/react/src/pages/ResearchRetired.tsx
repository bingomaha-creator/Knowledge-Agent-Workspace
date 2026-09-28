import { useNavigate } from 'react-router';
import { Button } from '@/ui/Button';
import { Empty } from '@/ui/Empty';
import { FeatureHeader } from '@/ui/FeatureHeader';
import { Panel } from '@/ui/Panel';

export function ResearchRetired() {
  const navigate = useNavigate();
  return <>
    <FeatureHeader title="旧版深度研究已退役" />
    <Panel><Empty title="旧研究记录不再提供页面查看"
      description="历史数据仍保留在本地，旧任务不会在新引擎中恢复。"
      action={<Button onClick={() => navigate('/research-new')}>进入深度研究</Button>} />
    </Panel>
  </>;
}
