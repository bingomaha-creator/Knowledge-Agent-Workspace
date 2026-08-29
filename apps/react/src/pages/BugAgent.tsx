import { useCallback, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { BugWorkspace, type BugInvestigationSeed } from '@/features/bug-agent/BugWorkspace';
import type { BugWorkspaceLocation } from '@/features/bug-agent/bugViewState';
import { buildBugUrl, parseBugLocation } from './bugRoute';

export function BugAgent() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const bugLocation = useMemo(
    () => parseBugLocation(params, searchParams),
    [params, searchParams]
  );
  const urlNeedsNormalization =
    params.section !== bugLocation.section ||
    (params.recordId === 'new' && !bugLocation.creating);

  useEffect(() => {
    if (!urlNeedsNormalization) return;
    navigate(buildBugUrl(bugLocation), { replace: true });
  }, [bugLocation, navigate, urlNeedsNormalization]);

  const onLocationChange = useCallback(
    (next: BugWorkspaceLocation, options?: { replace?: boolean }) => {
      navigate(buildBugUrl(next), { replace: options?.replace });
    },
    [navigate]
  );

  return (
    <BugWorkspace
      location={bugLocation}
      seed={(location.state as { bugInvestigationSeed?: BugInvestigationSeed } | null)?.bugInvestigationSeed}
      onLocationChange={onLocationChange}
    />
  );
}
