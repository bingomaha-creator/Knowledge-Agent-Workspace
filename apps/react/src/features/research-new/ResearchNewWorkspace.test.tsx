import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResearchNewRun } from '@/services/researchNewApi';
import { ResearchNewWorkspace } from './ResearchNewWorkspace';

const { run } = vi.hoisted(() => ({ run: {
  id: 'run-demo', question: '架构说明', mode: 'hybrid', knowledgeBaseIds: [],
  status: 'completed', stage: 'completed', progress: 100, error: '',
  resultQuality: 'sufficient', report: '# 架构说明\n\n本轮报告。',
  brief: {}, tracks: [], diagnostics: { engine: 'sidecar' },
  budget: { maxRounds: 2, maxSearchCalls: 8, maxSourcesRead: 10, maxWallTimeMs: 300000,
    maxWriterAttempts: 2, roundsUsed: 1, searchCalls: 2, sourcesRead: 1, writerAttempts: 1 },
  attempt: 1, cancelRequested: false, createdAt: 1, updatedAt: 2,
  startedAt: 1, finishedAt: 2, sources: ['第一段', '第二段'].map((title, index) => ({
    id: `source-${index}`, trackId: 'track-1', origin: 'workspace', title,
    documentId: 'doc-1', snippet: '', query: '', sourceKind: 'chunk'
  })), evidence: []
} as ResearchNewRun }));

vi.mock('./researchNewQueries', () => ({
  useResearchNewRuns: () => ({ data: [run] }),
  useResearchNewRun: () => ({ data: run }),
  useResearchNewCapabilities: () => ({ data: {} }),
  useResearchNewKnowledgeBases: () => ({ data: [] }),
  useResearchNewMutations: () => ({ cancel: { isPending: false } })
}));

describe('ResearchNewWorkspace quality wording', () => {
  it('distinguishes original character offsets from chunk positions', () => {
    const originalEvidence = run.evidence;
    const originalDiagnostics = run.diagnostics;
    run.evidence = ['context', 'chunk', 'unknown'].map((id) => ({
      id, trackId: 'track-1', sourceId: 'source-0', origin: 'workspace', passage: '原文',
      supports: [], contradicts: [], relevance: 1, sourceRole: 'primary', contentLevel: 'full_text'
    }));
    run.diagnostics = { sidecar: { evidenceTrace: [
      { evidenceId: 'context', chunkId: 'doc-1:context:1270:2100', position: 1270 },
      { evidenceId: 'chunk', chunkId: 'chunk-1', position: 0 }
    ] } };
    try {
      render(<ResearchNewWorkspace selectedRunId={run.id} onSelectRun={vi.fn()} />);
      expect(screen.getByText('项目文档 · 原文字符范围 1270–2100（从 0 起）')).toBeInTheDocument();
      expect(screen.getByText('项目文档 · 片段位置 0')).toBeInTheDocument();
      expect(screen.getByText('项目文档')).toBeInTheDocument();
      expect(screen.queryByText(/第 1270 段/)).not.toBeInTheDocument();
    } finally {
      run.evidence = originalEvidence;
      run.diagnostics = originalDiagnostics;
    }
  });

  it('does not present delivery checks as verified facts and keeps evidence limitations', () => {
    const view = render(<ResearchNewWorkspace selectedRunId={run.id} onSelectRun={vi.fn()} />);
    expect(screen.getByText('交付检查通过')).toBeInTheDocument();
    expect(screen.queryByText('证据充足')).not.toBeInTheDocument();
    expect(screen.getByText(/未进行逐句语义核验/)).toBeInTheDocument();
    expect(screen.getByText(/1 份项目文档/)).toBeInTheDocument();
    run.resultQuality = 'limited';
    view.rerender(<ResearchNewWorkspace selectedRunId={run.id} onSelectRun={vi.fn()} />);
    expect(screen.getByText('证据有限')).toBeInTheDocument();
    run.resultQuality = 'sufficient';
  });
});
