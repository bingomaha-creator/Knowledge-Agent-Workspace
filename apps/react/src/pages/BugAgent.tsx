import { getWorkspaceModule } from '@/app/navigation';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const bugAgentModule = getWorkspaceModule('bugs');

export function BugAgent() {
  return (
    <>
      <PageHeader
        eyebrow={bugAgentModule.eyebrow}
        title={bugAgentModule.label}
        description={bugAgentModule.description}
      />
      <Panel>
        <Empty
          icon="↗"
          title="Bug Agent 模块等待迁移"
          description="Bug 案例库和问题调查工作区将在对应 Feature 中接入。"
        />
      </Panel>
    </>
  );
}
