import styled from 'styled-components';

/**
 * 跨模块控制栏外壳：只统一白色背景、边距、底部分隔线和控件排列，
 * 并提供桌面/移动端的响应式行为。不理解任何业务字段。
 *
 * 直接子级的 input/select 由这里统一定制外观；min-width: 0 提供基础收缩能力。
 * 扩张规则归调用方所有：谁需要占据剩余空间，谁在自己的 styled 扩展里声明 flex。
 * 按钮同样由调用方提供，需与控件保持一致的 min-height、圆角和字号。
 */
export const WorkspaceControlBar = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);

  input,
  select {
    min-width: 0;
    min-height: 2.5rem;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font-size: 0.875rem;
  }

  @media (max-width: 48rem) {
    flex-wrap: wrap;
    padding: var(--space-3);
  }
`;
