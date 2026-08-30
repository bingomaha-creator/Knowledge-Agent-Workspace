import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ResearchWorkspace } from '@/features/research/ResearchWorkspace';
import type {
  ResearchDraftSeed,
  ResearchWorkspaceLocation
} from '@/features/research/researchViewState';
import { buildResearchUrl, parseResearchLocation } from './researchRoute';

/** Chat seed 只初始化草稿：校验形状，非法或缺失时按普通新建处理。 */
function parseDraftSeed(state: unknown): ResearchDraftSeed | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const candidate = (state as { researchDraftSeed?: unknown }).researchDraftSeed;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const seed = candidate as {
    question?: unknown;
    knowledgeBaseIds?: unknown;
    sourceSessionId?: unknown;
    sourceMessageId?: unknown;
  };
  if (typeof seed.question !== 'string' || !seed.question.trim()) return undefined;
  return {
    question: seed.question,
    knowledgeBaseIds: Array.isArray(seed.knowledgeBaseIds)
      ? seed.knowledgeBaseIds.filter((id): id is string => typeof id === 'string')
      : [],
    sourceSessionId: typeof seed.sourceSessionId === 'string' ? seed.sourceSessionId : undefined,
    sourceMessageId: typeof seed.sourceMessageId === 'string' ? seed.sourceMessageId : undefined
  };
}

export function Research() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const researchLocation = useMemo(
    () => parseResearchLocation(params, searchParams),
    [params, searchParams]
  );
  const draftSeed = useMemo(() => parseDraftSeed(location.state), [location.state]);

  // Chat seed 消费一次后清除 history state，刷新 /research/new 时显示普通空草稿。
  const seedConsumedRef = useRef(false);
  useEffect(() => {
    if (!draftSeed || seedConsumedRef.current) return;
    seedConsumedRef.current = true;
    navigate(`${location.pathname}${location.search}`, { replace: true });
  }, [draftSeed, location.pathname, location.search, navigate]);

  // 非法或显式 all 的 status 参数规范化为默认值后不保留在 URL 中。
  useEffect(() => {
    if (!searchParams.has('status') || researchLocation.status !== 'all') return;
    navigate(buildResearchUrl(researchLocation), { replace: true });
  }, [buildResearchUrl, navigate, researchLocation, searchParams]);

  const onLocationChange = useCallback(
    (next: ResearchWorkspaceLocation, options?: { replace?: boolean }) => {
      navigate(buildResearchUrl(next), { replace: options?.replace });
    },
    [navigate]
  );

  return (
    <ResearchWorkspace
      location={researchLocation}
      draftSeed={draftSeed}
      onLocationChange={onLocationChange}
    />
  );
}
