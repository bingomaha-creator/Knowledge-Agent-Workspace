import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkDocument, __test__ } from './markdown-chunker.js';

test('chunkDocument keeps markdown heading paths for section chunks', () => {
  const chunks = chunkDocument({
    name: 'guide.md',
    content: [
      '# 项目说明',
      '',
      '项目整体介绍。',
      '',
      '## RAG 流程',
      '',
      '上传文档后会分块并生成 embedding。',
      '',
      '## MCP 流程',
      '',
      '工具由 MCP Server 注册，Express 作为 Client 调用。'
    ].join('\n')
  });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0].headingPath, ['项目说明']);
  assert.deepEqual(chunks[1].headingPath, ['项目说明', 'RAG 流程']);
  assert.deepEqual(chunks[2].headingPath, ['项目说明', 'MCP 流程']);
  assert.match(chunks[1].text, /# 项目说明/);
  assert.match(chunks[1].text, /## RAG 流程/);
});

test('chunkDocument uses token budget instead of raw character length', () => {
  const chunks = chunkDocument({
    name: 'guide.md',
    content: [
      '# Guide',
      '',
      'alpha beta gamma delta epsilon zeta'
    ].join('\n'),
    chunkSize: 12,
    overlap: 3
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /alpha beta gamma delta epsilon zeta/);
});

test('markdown parser keeps fenced code blocks intact and ignores headings inside code', () => {
  const blocks = __test__.parseMarkdownBlocks([
    '## 示例',
    '',
    '```md',
    '### 这不是标题',
    '代码块内容',
    '```',
    '',
    '代码块后的正文。'
  ].join('\n'));

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'code');
  assert.deepEqual(blocks[0].headingPath, ['示例']);
  assert.match(blocks[0].text, /### 这不是标题/);
  assert.equal(blocks[1].type, 'paragraph');
});

test('markdown parser preserves a trailing hash when it belongs to the heading text', () => {
  const chunks = chunkDocument({
    name: 'dotnet.md',
    content: '# C#\n\nUse .NET.\n\n# Decorated ###\n\nDone.'
  });

  assert.deepEqual(chunks[0].headingPath, ['C#']);
  assert.match(chunks[0].text, /^# C#/);
  assert.deepEqual(chunks[1].headingPath, ['Decorated']);
});

test('oversized markdown sections repeat their heading context in every chunk', () => {
  const chunks = chunkDocument({
    name: 'long.md',
    content: '# Long Section\n\n' + Array.from({ length: 24 }, (_, index) => `word${index}`).join(' '),
    chunkSize: 12,
    overlap: 2
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.startsWith('# Long Section')));
  assert.ok(chunks.every((chunk) => chunk.headingPath[0] === 'Long Section'));
});

test('oversized fenced code blocks keep balanced fences in every chunk', () => {
  const code = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const chunks = chunkDocument({
    name: 'code.md',
    content: `# Example\n\n\`\`\`js\n${code}\n\`\`\``,
    chunkSize: 24,
    overlap: 2
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.includes('```js')));
  assert.ok(chunks.every((chunk) => chunk.text.trim().endsWith('```')));
});

test('chunkDocument falls back to plain text chunks for non-markdown documents', () => {
  const chunks = chunkDocument({
    name: 'notes.txt',
    content: 'a'.repeat(120),
    chunkSize: 50,
    overlap: 10
  });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0].headingPath, []);
  assert.equal(chunks[0].kind, 'plain-text');
});
