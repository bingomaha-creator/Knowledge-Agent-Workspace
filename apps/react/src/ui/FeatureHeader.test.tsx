import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeatureHeader } from './FeatureHeader';

describe('FeatureHeader', () => {
  it('renders title as h1 with optional description, meta and actions', () => {
    render(
      <FeatureHeader
        title="深度研究"
        description="以项目资料为背景生成研究报告。"
        meta={<span>3 条进行中</span>}
        actions={<button type="button">新建研究</button>}
      />
    );

    expect(screen.getByRole('heading', { level: 1, name: '深度研究' })).toBeInTheDocument();
    expect(screen.getByText('以项目资料为背景生成研究报告。')).toBeInTheDocument();
    expect(screen.getByText('3 条进行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建研究' })).toBeInTheDocument();
  });

  it('applies an incoming className so consumers can add responsive overrides', () => {
    const { container } = render(<FeatureHeader className="extra" title="Knowledge" />);

    expect(container.querySelector('header')).toHaveClass('extra');
  });
});
