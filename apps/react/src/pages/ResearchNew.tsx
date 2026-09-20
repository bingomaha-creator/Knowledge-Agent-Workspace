import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ResearchNewWorkspace } from '@/features/research-new/ResearchNewWorkspace';

export function ResearchNew() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const onSelectRun = useCallback((id?: string) => {
    navigate(id ? `/research-new/${encodeURIComponent(id)}` : '/research-new');
  }, [navigate]);

  return <ResearchNewWorkspace selectedRunId={runId} onSelectRun={onSelectRun} />;
}
