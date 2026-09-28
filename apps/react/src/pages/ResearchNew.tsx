import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ResearchNewWorkspace } from '@/features/research-new/ResearchNewWorkspace';

export function ResearchNew() {
  const navigate = useNavigate();
  const location = useLocation();
  const { runId } = useParams();
  const [initialQuestion, setInitialQuestion] = useState(() => {
    const question = location.state?.researchDraftSeed?.question;
    return runId === 'new' && typeof question === 'string' ? question.trim().slice(0, 4000) : undefined;
  });
  useEffect(() => {
    if (location.state?.researchDraftSeed) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.pathname, location.search, location.state, navigate]);
  const onSelectRun = useCallback((id?: string) => {
    setInitialQuestion(undefined);
    navigate(id ? `/research-new/${encodeURIComponent(id)}` : '/research-new');
  }, [navigate]);

  return <ResearchNewWorkspace selectedRunId={runId} initialQuestion={initialQuestion} onSelectRun={onSelectRun} />;
}
