import { describe, expect, it } from 'vitest';
import {
  hasPendingKnowledgeDocuments,
  knowledgeQueryKeys,
  resolveKnowledgeBaseId
} from './knowledgeQueries';

const bases = [
  { id: 'kb-default', isDefault: true },
  { id: 'kb-project', isDefault: false }
];

describe('knowledge query rules', () => {
  it('uses one shared catalog key and scoped document/preview keys', () => {
    expect(knowledgeQueryKeys.bases()).toEqual(['knowledge', 'bases']);
    expect(knowledgeQueryKeys.documents('kb-project')).toEqual(['knowledge', 'documents', 'kb-project']);
    expect(knowledgeQueryKeys.preview('kb-project', 'doc-1')).toEqual([
      'knowledge', 'preview', 'kb-project', 'doc-1'
    ]);
  });

  it('resolves an invalid URL selection to the default base', () => {
    expect(resolveKnowledgeBaseId(bases, 'kb-project')).toBe('kb-project');
    expect(resolveKnowledgeBaseId(bases, 'kb-missing')).toBe('kb-default');
    expect(resolveKnowledgeBaseId([], 'kb-missing')).toBeUndefined();
  });

  it('polls only while at least one document is queued or processing', () => {
    expect(hasPendingKnowledgeDocuments([{ status: 'queued' }])).toBe(true);
    expect(hasPendingKnowledgeDocuments([{ status: 'processing' }])).toBe(true);
    expect(hasPendingKnowledgeDocuments([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
  });
});
