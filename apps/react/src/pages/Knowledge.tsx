import { getWorkspaceModule } from '@/app/navigation';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const knowledgeModule = getWorkspaceModule('knowledge');

export function Knowledge() {
  return (
    <>
      <PageHeader
        eyebrow={knowledgeModule.eyebrow}
        title={knowledgeModule.label}
        description={knowledgeModule.description}
      />
      <Panel>
        <Empty
          icon="↗"
          title="Knowledge 模块等待迁移"
          description="资料库、文档生命周期和预览将在对应 Feature 中实现，Page 继续只负责路由级组装。"
        />
      </Panel>
    </>
  );
}
