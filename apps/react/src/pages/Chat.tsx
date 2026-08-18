import { getWorkspaceModule } from '@/app/navigation';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const chatModule = getWorkspaceModule('chat');

export function Chat() {
  return (
    <>
      <PageHeader
        eyebrow={chatModule.eyebrow}
        title={chatModule.label}
        description={chatModule.description}
      />
      <Panel>
        <Empty
          icon="↗"
          title="Chat 模块等待迁移"
          description="历史会话、流式回答和输入区域将在第一个业务 Feature 中接入；当前页面只验证应用框架和路由入口。"
        />
      </Panel>
    </>
  );
}
