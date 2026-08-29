import type {
  BugProcessingStatus,
  BugReviewStatus,
  BugScope
} from '@/services/bugAgentApi';

export type BugSection = 'investigations' | 'review' | 'library';

export type BugInvestigationView = 'active' | 'history';

export type BugCaseFilters = {
  scope?: BugScope;
  reviewStatus: BugReviewStatus;
  processingStatus?: BugProcessingStatus;
  language: string;
  framework: string;
  query: string;
  includeCommon: boolean;
  additionalProjectRefs: string[];
};

export type BugWorkspaceLocation = {
  section: BugSection;
  projectRef?: string;
  recordId?: string;
  creating: boolean;
  investigationView: BugInvestigationView;
  caseFilters: BugCaseFilters;
};

export function defaultBugCaseFilters(): BugCaseFilters {
  return {
    scope: undefined,
    reviewStatus: 'candidate',
    processingStatus: undefined,
    language: '',
    framework: '',
    query: '',
    includeCommon: true,
    additionalProjectRefs: []
  };
}
