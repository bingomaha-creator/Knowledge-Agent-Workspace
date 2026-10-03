import { createGlobalStyle, css } from 'styled-components';

const darkColors = css`
  color-scheme: dark;
  --color-background: #101722;
  --color-sidebar: rgba(20, 30, 47, 0.96);
  --color-surface: rgba(25, 36, 54, 0.96);
  --color-surface-muted: #24334b;
  --color-border: #354861;
  --color-text: #e5edf7;
  --color-text-muted: #aebbd0;
  --color-text-subtle: #94a5bf;
  --color-primary: #8ab8ff;
  --color-primary-border: #466892;
  --color-primary-surface: #223858;
  --color-text-on-primary: #10233e;
  --color-danger: #ff9a9a;
  --color-danger-border: #925b67;
  --color-danger-surface: #39272f;
  --color-success: #71dba3;
  --color-success-border: #426e58;
  --color-success-surface: #203d31;
  --color-focus: rgba(138, 184, 255, 0.65);
  --color-selection: rgba(138, 184, 255, 0.25);
  --color-ambient: rgba(49, 80, 123, 0.22);
  --color-header: rgba(25, 36, 54, 0.9);
  --color-header-mobile: rgba(16, 23, 34, 0.94);
  --shadow-soft: 0 18px 48px rgba(0, 0, 0, 0.18);
  --shadow-drawer: 18px 0 48px rgba(0, 0, 0, 0.4);
`;

export const GlobalStyles = createGlobalStyle`
  :root {
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    color: var(--color-text);
    background: var(--color-background);
    color-scheme: light;
    font-synthesis: none;
    text-rendering: optimizeLegibility;

    --color-background: #f7f9fd;
    --color-sidebar: rgba(236, 243, 255, 0.96);
    --color-surface: rgba(255, 255, 255, 0.96);
    --color-surface-muted: #eef4ff;
    --color-border: #dbe3f0;
    --color-text: #202736;
    --color-text-muted: #727d91;
    --color-text-subtle: #8791a4;
    --color-primary: #1764d8;
    --color-primary-border: #bdd3f7;
    --color-primary-surface: #eaf2ff;
    --color-text-on-primary: #ffffff;
    --color-danger: #b84343;
    --color-danger-border: #eab5b5;
    --color-danger-surface: #fff3f3;
    --color-success: #1d8650;
    --color-success-border: #a9ddbf;
    --color-success-surface: #effbf4;
    --color-focus: rgba(23, 100, 216, 0.42);
    --color-selection: rgba(23, 100, 216, 0.18);
    --color-ambient: rgba(213, 228, 255, 0.72);
    --color-header: rgba(255, 255, 255, 0.88);
    --color-header-mobile: rgba(247, 249, 253, 0.94);

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-7: 28px;
    --space-8: 32px;

    --radius-control: 14px;
    --radius-card: 22px;
    --radius-panel: 24px;
    --shadow-soft: 0 18px 48px rgba(77, 102, 144, 0.08);
    --shadow-drawer: 18px 0 48px rgba(30, 49, 80, 0.16);
    --content-max: 1180px;
    --sidebar-width: 320px;
    --pane-master-width: 21rem;

    /* 第三方样式只通过公开变量接入，设计值继续由本文件拥有。 */
    --matthew-ui-color-text: var(--color-text);
    --matthew-ui-color-text-muted: var(--color-text-muted);
    --matthew-ui-color-primary: var(--color-primary);
    --matthew-ui-color-danger: var(--color-danger);
    --matthew-ui-color-border: var(--color-border);
    --matthew-ui-color-focus: var(--color-focus);
    --matthew-ui-color-surface-hover: var(--color-surface-muted);
    --matthew-ui-radius-md: var(--radius-control);
    --matthew-ui-control-height-md: 2.5rem;
    --matthew-ui-font-size-sm: 0.8125rem;
    --matthew-ui-font-size-md: 0.875rem;
    --matthew-ui-duration-fast: 150ms;
    --matthew-ui-thinking-completed-color: var(--color-success);
    --matthew-ui-tool-call-completed-color: var(--color-success);
  }

  :root[data-theme='dark'] { ${darkColors} }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']):not([data-theme='dark']) { ${darkColors} }
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  html,
  #root {
    min-width: 0;
    min-height: 100%;
  }

  body {
    margin: 0;
    min-width: 0;
    min-height: 100vh;
    background:
      radial-gradient(circle at 30% 0%, var(--color-ambient), transparent 32rem),
      var(--color-background);
    color: var(--color-text);
  }

  button,
  input,
  textarea,
  select {
    font: inherit;
  }

  button,
  a {
    -webkit-tap-highlight-color: transparent;
  }

  button:not(:disabled) {
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
  }

  a {
    color: inherit;
  }

  :focus-visible {
    outline: 3px solid var(--color-focus);
    outline-offset: 3px;
  }

  ::selection {
    background: var(--color-selection);
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
