import type { ReactNode } from 'react';
import styled from 'styled-components';

type MasterDetailLayoutProps = {
  master: ReactNode;
  detail: ReactNode;
  masterWidth?: string;
  mobilePane: 'master' | 'detail';
  masterLabel?: string;
  detailLabel?: string;
};

const Layout = styled.div<{ $masterWidth: string }>`
  display: grid;
  grid-template-columns: ${({ $masterWidth }) => $masterWidth} minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  @media (max-width: 48rem) {
    display: block;
  }
`;

const Pane = styled.section<{ $kind: 'master' | 'detail'; $mobilePane: 'master' | 'detail' }>`
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: ${({ $kind }) => $kind === 'master' ? '1px solid var(--color-border)' : '0'};

  @media (max-width: 48rem) {
    display: ${({ $kind, $mobilePane }) => $kind === $mobilePane ? 'flex' : 'none'};
    height: 100%;
    flex-direction: column;
    border-right: 0;
  }
`;

export function MasterDetailLayout({
  master,
  detail,
  masterWidth = 'var(--pane-master-width)',
  mobilePane,
  masterLabel,
  detailLabel
}: MasterDetailLayoutProps) {
  return (
    <Layout $masterWidth={masterWidth}>
      <Pane $kind="master" $mobilePane={mobilePane} aria-label={masterLabel}>{master}</Pane>
      <Pane $kind="detail" $mobilePane={mobilePane} aria-label={detailLabel}>{detail}</Pane>
    </Layout>
  );
}
