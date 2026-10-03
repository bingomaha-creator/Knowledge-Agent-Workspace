import { forwardRef, type ButtonHTMLAttributes } from 'react';
import styled from 'styled-components';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'md' | 'sm';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variantStyles: Record<ButtonVariant, string> = {
  primary: `
    border-color: var(--color-primary);
    color: white;
    background: var(--color-primary);

    &:hover:not(:disabled) { filter: brightness(0.94); }
  `,
  secondary: `
    border-color: var(--color-border);
    color: var(--color-text);
    background: var(--color-surface);

    &:hover:not(:disabled) { border-color: var(--color-primary-border); }
  `,
  danger: `
    border-color: var(--color-danger-border);
    color: var(--color-danger);
    background: var(--color-surface);

    &:hover:not(:disabled) { background: var(--color-danger-surface); }
  `
};

const StyledButton = styled.button<{ $variant: ButtonVariant; $size: ButtonSize }>`
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-height: ${({ $size }) => ($size === 'sm' ? '2.25rem' : '2.5rem')};
  padding: ${({ $size }) => ($size === 'sm' ? '0.35rem 0.7rem' : '0.45rem 0.85rem')};
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  font-size: 0.875rem;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
  ${({ $variant }) => variantStyles[$variant]}

  &:disabled { cursor: not-allowed; opacity: 0.55; }
`;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type = 'button', ...rest },
  ref
) {
  return <StyledButton ref={ref} type={type} $variant={variant} $size={size} {...rest} />;
});
