import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSafeMarkdown, SafeMarkdown } from './SafeMarkdown';

// DOMPurify 的 URI 白名单是它自己的、在真实浏览器中久经考验的契约；
// 这里的测试对象是 SafeMarkdown 自身：markdown-it 的安全默认值，
// 以及把 linkPolicy 正确传给 sanitizer 的管道。happy-dom 环境下
// DOMPurify 的树解析存在与本测试无关的序列化差异，因此对 sanitize 做打桩。
const { sanitize } = vi.hoisted(() => ({
  sanitize: vi.fn((html: string, _config?: Record<string, unknown>) => html)
}));

vi.mock('dompurify', () => ({
  default: vi.fn(() => ({ sanitize }))
}));

describe('SafeMarkdown', () => {
  beforeEach(() => {
    sanitize.mockClear();
    sanitize.mockImplementation((html: string) => html);
  });

  it('passes rendered markdown through the sanitizer', () => {
    renderSafeMarkdown('# 标题\n\n正文');
    expect(sanitize).toHaveBeenCalledTimes(1);
    const [html] = sanitize.mock.calls[0];
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<p>正文</p>');
  });

  it('uses the default sanitizer config for the standard policy (chat parity)', () => {
    renderSafeMarkdown('**加粗**');
    const [, config] = sanitize.mock.calls[0];
    expect(config).toBeUndefined();
  });

  it('requests the https-only URI allowlist for external report links', () => {
    renderSafeMarkdown('[站点](https://example.com)', 'https-only');
    const config = sanitize.mock.calls[0][1] as { ALLOWED_URI_REGEXP: RegExp };
    expect(config).toBeDefined();
    expect(config.ALLOWED_URI_REGEXP.test('https://example.com')).toBe(true);
    expect(config.ALLOWED_URI_REGEXP.test('http://example.com')).toBe(false);
    expect(config.ALLOWED_URI_REGEXP.test('javascript:alert(1)')).toBe(false);
  });

  it('escapes raw HTML at the markdown layer (html: false)', () => {
    renderSafeMarkdown('<script>alert(1)</script>\n\n正文');
    const [html] = sanitize.mock.calls[0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script');
  });

  it('drops javascript: links at the markdown layer before sanitizing', () => {
    renderSafeMarkdown('[点击](javascript:alert(1))');
    const [html] = sanitize.mock.calls[0];
    expect(html).not.toContain('<a');
    expect(html).toContain('点击');
  });

  it('renders sanitized html through the component', () => {
    sanitize.mockImplementation((html: string) => html.replace('NEEDS-ESCAPE', ''));
    const { container } = render(<SafeMarkdown content="NEEDS-ESCAPE 正文" linkPolicy="https-only" />);
    expect(sanitize).toHaveBeenCalledWith('<p>NEEDS-ESCAPE 正文</p>\n', { ALLOWED_URI_REGEXP: /^https:/i });
    expect(container.textContent).toContain('正文');
  });
});
