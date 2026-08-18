import { Link } from 'react-router';
import styled from 'styled-components';
import { Empty } from '@/ui/Empty';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

const HomeLink = styled(Link)`
  display: inline-flex;
  min-height: 2.625rem;
  align-items: center;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--color-primary-border);
  border-radius: var(--radius-control);
  color: var(--color-primary);
  background: var(--color-primary-surface);
  font-weight: 700;
  text-decoration: none;
`;

export function PageNotFound() {
  return (
    <>
      <PageHeader
        eyebrow="NOT FOUND"
        title="页面不存在"
        description="当前地址不属于 Matthew's Workspace 的已知模块。"
      />
      <Panel>
        <Empty
          icon="404"
          title="没有找到这个页面"
          description="返回对话工作区继续使用。"
          action={<HomeLink to="/chat">返回对话</HomeLink>}
        />
      </Panel>
    </>
  );
}
