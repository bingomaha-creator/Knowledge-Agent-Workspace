import styled from 'styled-components';
import { SafeMarkdown } from '@/ui/SafeMarkdown';

const Section = styled.section`
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);

  h3 { margin: 0; font-size: 0.95rem; }
`;

const ReportBody = styled(SafeMarkdown)`
  min-width: 0;
  max-width: 46rem;
  color: var(--color-text);
  font-size: 0.875rem;
  line-height: 1.75;
  overflow-wrap: anywhere;

  > :first-child { margin-top: 0; }
  > :last-child { margin-bottom: 0; }
  p, ul, ol, blockquote { margin: 0.7rem 0; }
  h1, h2, h3, h4 { margin: 1.1rem 0 0.5rem; line-height: 1.35; }
  a { color: var(--color-primary); overflow-wrap: anywhere; }
  blockquote {
    margin: 0.7rem 0;
    padding-left: var(--space-3);
    border-left: 3px solid var(--color-primary-border);
    color: var(--color-text-muted);
  }
  code {
    padding: 0.1em 0.35em;
    border-radius: 0.35rem;
    background: var(--color-surface-muted);
    font-size: 0.9em;
  }
  pre {
    max-width: 100%;
    padding: var(--space-3);
    overflow-x: auto;
    border-radius: 0.8rem;
    background: #182235;
    color: #e8eef8;
    white-space: pre;
  }
  table {
    max-width: 100%;
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  th, td {
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--color-border);
    text-align: left;
  }
  img { max-width: 100%; }
`;

export function ResearchReport({ report }: { report: string }) {
  return (
    <Section aria-labelledby="research-report-title">
      <h3 id="research-report-title">最终报告</h3>
      <ReportBody content={report} linkPolicy="https-only" />
    </Section>
  );
}
