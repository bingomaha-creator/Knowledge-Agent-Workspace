import { getWorkspaceModule } from '@/app/navigation';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const researchModule = getWorkspaceModule('research');

export function Research() {
  return (
    <>
      <PageHeader
        eyebrow={researchModule.eyebrow}
        title={researchModule.label}
        description={researchModule.description}
      />
      <Panel>
        <Empty
          icon="↗"
          title="Research 模块等待迁移"
          description="研究计划、证据、诊断和报告将在对应 Feature 中接入。"
        />
      </Panel>
    </>
  );
}
