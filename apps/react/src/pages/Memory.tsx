import { getWorkspaceModule } from '@/app/navigation';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const memoryModule = getWorkspaceModule('memory');

export function Memory() {
  return (
    <>
      <PageHeader
        eyebrow={memoryModule.eyebrow}
        title={memoryModule.label}
        description={memoryModule.description}
      />
      <Panel>
        <Empty
          icon="↗"
          title="Memory 模块等待迁移"
          description="候选记忆、人工审核和来源会话将在对应 Feature 中接入。"
        />
      </Panel>
    </>
  );
}
