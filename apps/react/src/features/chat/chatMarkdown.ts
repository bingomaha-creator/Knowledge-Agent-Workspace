import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});
const purifier = DOMPurify(window);

export function renderChatMarkdown(content: string) {
  return purifier.sanitize(markdown.render(content));
}
