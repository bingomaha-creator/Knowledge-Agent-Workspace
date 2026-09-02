import { createGlobalStyle } from 'styled-components';

export const GlobalStyles = createGlobalStyle`
  :root {
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
    color: #202736;
    background: #f7f9fd;
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
    --color-danger: #b84343;
    --color-danger-border: #eab5b5;
    --color-danger-surface: #fff3f3;
    --color-success: #1d8650;
    --color-success-border: #a9ddbf;
    --color-success-surface: #effbf4;

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
      radial-gradient(circle at 30% 0%, rgba(213, 228, 255, 0.72), transparent 32rem),
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
    outline: 3px solid rgba(23, 100, 216, 0.42);
    outline-offset: 3px;
  }

  ::selection {
    background: rgba(23, 100, 216, 0.18);
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
