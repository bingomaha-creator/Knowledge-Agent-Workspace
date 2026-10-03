import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});
const purifier = DOMPurify(window);

// standard：DOMPurify 默认策略（javascript:/data: 等协议仍被禁用），保持 Chat 现有行为。
// https-only：研究报告等外部引用场景，仅 HTTPS 链接可点击，其余保留为纯文本。
export type SafeMarkdownLinkPolicy = 'standard' | 'https-only' | 'https-and-evidence';

const HTTPS_ONLY_URI_REGEXP = /^https:/i;
const RESEARCH_URI_REGEXP = /^(?:https:|#evidence-[a-z0-9_-]+$)/i;

export function renderSafeMarkdown(content: string, linkPolicy: SafeMarkdownLinkPolicy = 'standard') {
  const rendered = markdown.render(content);
  if (linkPolicy === 'https-only') return purifier.sanitize(rendered, { ALLOWED_URI_REGEXP: HTTPS_ONLY_URI_REGEXP });
  if (linkPolicy === 'https-and-evidence') return purifier.sanitize(rendered, { ALLOWED_URI_REGEXP: RESEARCH_URI_REGEXP });
  return purifier.sanitize(rendered);
}

type SafeMarkdownProps = {
  content: string;
  linkPolicy?: SafeMarkdownLinkPolicy;
  className?: string;
};

export function SafeMarkdown({ content, linkPolicy = 'standard', className }: SafeMarkdownProps) {
  const html = useMemo(() => renderSafeMarkdown(content, linkPolicy), [content, linkPolicy]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
