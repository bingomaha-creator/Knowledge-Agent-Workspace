import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import styled from 'styled-components';

export type FeedbackTone = 'neutral' | 'danger';

type FeedbackProps = Omit<ComponentPropsWithoutRef<'p'>, 'children'> & {
  /** 视觉色调，默认 neutral。朗读语义（role）独立于此项，由调用方显式传入。 */
  tone?: FeedbackTone;
  /** 行内操作（如重试按钮），由调用方提供内容与回调，样式由本组件统一。 */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

const StyledFeedback = styled.p<{ $danger: boolean }>`
  margin: 0;
  padding: var(--space-2) var(--space-5);
  color: ${({ $danger }) => ($danger ? 'var(--color-danger)' : 'var(--color-text)')};
  background: ${({ $danger }) => ($danger ? 'var(--color-danger-surface)' : 'var(--color-background)')};
  font-size: 0.75rem;

  button {
    margin-left: var(--space-2);
    border: 0;
    color: inherit;
    background: transparent;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
`;

export function Feedback({ tone = 'neutral', action, children, className, ...rest }: FeedbackProps) {
  return (
    <StyledFeedback className={className} $danger={tone === 'danger'} {...rest}>
      {children}
      {action}
    </StyledFeedback>
  );
}
