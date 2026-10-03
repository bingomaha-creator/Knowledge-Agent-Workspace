import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders a non-submitting button by default and forwards interactions', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);

    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toHaveAttribute('type', 'button');
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit submit type and native attributes', () => {
    render(<Button type="submit" disabled form="checkout">提交</Button>);

    const button = screen.getByRole('button', { name: '提交' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('form', 'checkout');
    expect(button).toBeDisabled();
  });

  it('does not leak style props into the DOM and exposes the ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} variant="primary" size="sm">操作</Button>);

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).not.toHaveAttribute('variant');
    expect(ref.current).not.toHaveAttribute('size');
  });
});
