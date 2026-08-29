import { describe, expect, it } from 'vitest';
import { defaultBugCaseFilters, type BugWorkspaceLocation } from '@/features/bug-agent/bugViewState';
import { buildBugUrl, parseBugLocation } from './bugRoute';

const fullFilters = {
  scope: 'common' as const,
  reviewStatus: 'confirmed' as const,
  processingStatus: 'ready' as const,
  language: 'TypeScript',
  framework: 'React',
  query: '支付失败',
  includeCommon: false,
  additionalProjectRefs: ['a', 'b']
};

describe('bugRoute', () => {
  it('parses a deep link into the workspace location', () => {
    expect(parseBugLocation(
      { section: 'review', recordId: 'case-1' },
      new URLSearchParams('project=p1&view=history&scope=common&reviewStatus=confirmed&processingStatus=ready&language=TypeScript&framework=React&q=支付失败&includeCommon=false&projects=b,a')
    )).toEqual({
      section: 'review',
      projectRef: 'p1',
      recordId: 'case-1',
      creating: false,
      investigationView: 'history',
      caseFilters: fullFilters
    });
  });

  it('parses the new-record route into the creating state without a record id', () => {
    expect(parseBugLocation({ section: 'review', recordId: 'new' }, new URLSearchParams('project=p1'))).toEqual({
      section: 'review',
      projectRef: 'p1',
      recordId: undefined,
      creating: true,
      investigationView: 'active',
      caseFilters: defaultBugCaseFilters()
    });
  });

  it('normalizes an invalid section and invalid filter enums to defaults', () => {
    expect(parseBugLocation(
      { section: 'bogus' },
      new URLSearchParams('scope=nope&reviewStatus=nope&processingStatus=nope&view=nope&projects=,,')
    )).toEqual({
      section: 'investigations',
      projectRef: undefined,
      recordId: undefined,
      creating: false,
      investigationView: 'active',
      caseFilters: defaultBugCaseFilters()
    });
  });

  it('derives defaults for missing params and keeps includeCommon=false', () => {
    const location = parseBugLocation({ section: 'library' }, new URLSearchParams('includeCommon=false&projects=a'));

    expect(location.caseFilters.includeCommon).toBe(false);
    expect(location.caseFilters.additionalProjectRefs).toEqual(['a']);
    expect(location.caseFilters.reviewStatus).toBe('candidate');
    expect(location.investigationView).toBe('active');
  });

  it('builds canonical URLs without default params', () => {
    expect(buildBugUrl({
      section: 'investigations',
      creating: false,
      investigationView: 'active',
      caseFilters: defaultBugCaseFilters()
    })).toBe('/bugs/investigations');

    expect(buildBugUrl({
      section: 'review',
      projectRef: 'p1',
      creating: true,
      investigationView: 'active',
      caseFilters: { ...defaultBugCaseFilters(), reviewStatus: 'rejected' }
    })).toBe('/bugs/review/new?project=p1&reviewStatus=rejected');
  });

  it('keeps parse and build round-trip stable', () => {
    const location: BugWorkspaceLocation = {
      section: 'library',
      projectRef: 'p1',
      recordId: 'case 1',
      creating: false,
      investigationView: 'history',
      caseFilters: fullFilters
    };

    const query = buildBugUrl(location).split('?')[1] || '';
    const parsed = parseBugLocation({ section: 'library', recordId: 'case 1' }, new URLSearchParams(query));

    expect(parsed).toEqual(location);
    expect(buildBugUrl(parsed)).toBe(buildBugUrl(location));
  });

  it.each([
    ['investigations', undefined],
    ['investigations', 'new'],
    ['investigations', 'inv-1'],
    ['review', undefined],
    ['review', 'new'],
    ['review', 'case-1'],
    ['library', undefined],
    ['library', 'case-1']
  ] as const)('round-trips the legal path /bugs/%s/%s', (section, recordId) => {
    const creating = recordId === 'new';
    const location: BugWorkspaceLocation = {
      section,
      projectRef: 'p1',
      recordId: creating ? undefined : recordId,
      creating,
      investigationView: 'history',
      caseFilters: fullFilters
    };

    const url = buildBugUrl(location);
    const [path, query = ''] = url.split('?');
    const [, , routeSection, routeRecordId] = path.split('/');

    expect(parseBugLocation({ section: routeSection, recordId: routeRecordId }, new URLSearchParams(query)))
      .toEqual(location);
    expect(buildBugUrl(parseBugLocation({ section: routeSection, recordId: routeRecordId }, new URLSearchParams(query))))
      .toBe(url);
    expect(url.startsWith(`/bugs/${section}${creating ? '/new' : recordId ? `/${recordId}` : ''}`)).toBe(true);
  });

  it('normalizes the library create path to the library list state', () => {
    const location = parseBugLocation(
      { section: 'library', recordId: 'new' },
      new URLSearchParams('project=p1&q=foo')
    );

    expect(location).toEqual({
      section: 'library',
      projectRef: 'p1',
      recordId: undefined,
      creating: false,
      investigationView: 'active',
      caseFilters: { ...defaultBugCaseFilters(), query: 'foo' }
    });
    expect(buildBugUrl(location)).toBe('/bugs/library?project=p1&q=foo');
  });
});
