import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Feedback } from './Feedback';

describe('Feedback', () => {
  it('renders children with neutral tone by default and does not force a role', () => {
    render(<Feedback>文件已上传。</Feedback>);

    const el = screen.getByText('文件已上传。');
    expect(el.tagName).toBe('P');
    expect(el).not.toHaveAttribute('role');
  });

  it('keeps an explicit role independent of tone and renders the caller action', () => {
    const onRetry = vi.fn();
    render(
      <Feedback tone="danger" role="alert" action={<button type="button" onClick={onRetry}>重试</button>}>
        无法加载资料库目录。
      </Feedback>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('无法加载资料库目录。');
    expect(screen.getByRole('alert')).not.toHaveAttribute('aria-live');
    screen.getByRole('button', { name: '重试' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a neutral status role without danger styling assumptions', () => {
    render(<Feedback role="status">知识已发布，现在可供 AI 检索。</Feedback>);

    expect(screen.getByRole('status')).toHaveTextContent('知识已发布，现在可供 AI 检索。');
  });
});
