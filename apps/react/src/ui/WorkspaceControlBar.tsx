import styled from 'styled-components';

/**
 * 跨模块控制栏外壳：统一白色背景、边距、底部分隔线和控件排列，
 * 并提供桌面/移动端的响应式行为。不理解任何业务字段。
 *
 * 外壳保留直接子级 input 的统一控件皮肤（Memory 搜索等仍在使用）；
 * 下拉选择统一使用 ui/Select（自带控件外观），按钮由调用方使用共享组件。
 * min-width: 0 提供基础收缩能力；扩张规则归调用方所有——
 * 谁需要占据剩余空间，谁在自己的 styled 扩展里声明 flex。
 */
export const WorkspaceControlBar = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);

  input {
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
