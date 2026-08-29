import {
  defaultBugCaseFilters,
  type BugCaseFilters,
  type BugSection,
  type BugWorkspaceLocation
} from '@/features/bug-agent/bugViewState';

type BugScope = NonNullable<BugCaseFilters['scope']>;
type BugReviewStatus = BugCaseFilters['reviewStatus'];
type BugProcessingStatus = NonNullable<BugCaseFilters['processingStatus']>;

type BugRouteParams = {
  section?: string;
  recordId?: string;
};

const sections: readonly BugSection[] = ['investigations', 'review', 'library'];
const scopes: readonly BugScope[] = ['project', 'common'];
const reviewStatuses: readonly BugReviewStatus[] = ['candidate', 'confirmed', 'rejected'];
const processingStatuses: readonly BugProcessingStatus[] = ['queued', 'processing', 'ready', 'failed'];

function parseCaseFilters(searchParams: URLSearchParams): BugCaseFilters {
  const scopeValue = searchParams.get('scope');
  const reviewStatusValue = searchParams.get('reviewStatus');
  const processingStatusValue = searchParams.get('processingStatus');

  return {
    scope: scopes.includes(scopeValue as BugScope) ? scopeValue as BugScope : undefined,
    reviewStatus: reviewStatuses.includes(reviewStatusValue as BugReviewStatus)
      ? reviewStatusValue as BugReviewStatus
      : 'candidate',
    processingStatus: processingStatuses.includes(processingStatusValue as BugProcessingStatus)
      ? processingStatusValue as BugProcessingStatus
      : undefined,
    language: searchParams.get('language') || '',
    framework: searchParams.get('framework') || '',
    query: searchParams.get('q') || '',
    includeCommon: searchParams.get('includeCommon') !== 'false',
    additionalProjectRefs: (searchParams.get('projects') || '').split(',').filter(Boolean).sort()
  };
}

export function parseBugLocation(params: BugRouteParams, searchParams: URLSearchParams): BugWorkspaceLocation {
  const section = sections.includes(params.section as BugSection)
    ? params.section as BugSection
    : 'investigations';
  const rawRecordId = params.recordId;
  const supportsCreate = section === 'investigations' || section === 'review';

  return {
    section,
    projectRef: searchParams.get('project') || undefined,
    recordId: rawRecordId && rawRecordId !== 'new' ? rawRecordId : undefined,
    creating: rawRecordId === 'new' && supportsCreate,
    investigationView: searchParams.get('view') === 'history' ? 'history' : 'active',
    caseFilters: parseCaseFilters(searchParams)
  };
}

export function buildBugUrl(location: BugWorkspaceLocation): string {
  const filters = location.caseFilters;
  const params = new URLSearchParams();

  if (location.projectRef) params.set('project', location.projectRef);
  if (location.investigationView === 'history') params.set('view', 'history');
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.reviewStatus !== 'candidate') params.set('reviewStatus', filters.reviewStatus);
  if (filters.processingStatus) params.set('processingStatus', filters.processingStatus);
  if (filters.language) params.set('language', filters.language);
  if (filters.framework) params.set('framework', filters.framework);
  if (filters.query) params.set('q', filters.query);
  if (!filters.includeCommon) params.set('includeCommon', 'false');
  if (filters.additionalProjectRefs.length) {
    params.set('projects', [...filters.additionalProjectRefs].sort().join(','));
  }

  const query = params.toString();
  const recordId = location.creating ? 'new' : location.recordId ? encodeURIComponent(location.recordId) : undefined;
  const path = `/bugs/${location.section}${recordId ? `/${recordId}` : ''}`;

  return query ? `${path}?${query}` : path;
}
