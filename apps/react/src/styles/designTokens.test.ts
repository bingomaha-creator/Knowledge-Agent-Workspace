/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = resolve(process.cwd(), 'src');

function sourceFiles(): string[] {
  const entries = readdirSync(srcDir, { recursive: true }) as string[];
  return entries
    .filter((entry) => /\.tsx?$/.test(entry))
    .filter((entry) => !entry.includes('.test.'))
    .filter((entry) => entry !== 'matthew-ui-test.tsx')
    .map((entry) => resolve(srcDir, entry));
}

describe('design tokens', () => {
  it('only references design-system CSS variables that GlobalStyles defines', () => {
    const globalStyles = readFileSync(resolve(srcDir, 'styles/GlobalStyles.ts'), 'utf-8');
    const defined = new Set(
      [...globalStyles.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1])
    );
    // cwd 或目录结构变化时让测试显式失败，而不是静默扫描了空集。
    expect(defined.size).toBeGreaterThan(10);

    // 只检查设计系统拥有的 token 族（方案 §3.1）；组件内部的局部动态 CSS 变量不属于本检查范围。
    const designTokenFamilies = /^--(color|radius|space|shadow|pane|sidebar|content)-/;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/var\((--[a-z0-9-]+)[,)]/g)) {
        const token = match[1];
        if (!designTokenFamilies.test(token)) continue;
        if (!defined.has(token)) offenders.push(`${file}: ${token}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
