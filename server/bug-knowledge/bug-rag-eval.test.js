import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBugKnowledgeService } from './bug-knowledge-service.js';
import {
  buildBugCaseFingerprint,
  normalizeBugCaseContent,
  renderBugCaseDocument
} from './bug-case-domain.js';
import {
  COMMON_BUG_KNOWLEDGE_BASE_ID,
  createKnowledgeStore
} from '../knowledge-store.js';
import { tokenize } from '../rag-utils.js';
import { createKnowledgeService } from '../services/knowledge-service.js';

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/bug-rag-eval.json', import.meta.url),
  'utf8'
));

function deterministicEmbedding(text) {
  const vector = Array.from({ length: 24 }, () => 0);
  for (const token of tokenize(text)) {
    let hash = 2166136261;
    for (const character of token) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % vector.length] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function createEvalService(t, { vectorAvailable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-bug-eval-'));
  const store = createKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const projects = new Map();
  for (const project of fixture.projects) {
    projects.set(project.projectRef, store.createBugProject(project));
  }
  for (const source of fixture.cases) {
    const {
      id,
      sourceProjectRef,
      scope,
      reviewStatus,
      ...rawContent
    } = source;
    const content = normalizeBugCaseContent(rawContent);
    const knowledgeBaseId = scope === 'common'
      ? COMMON_BUG_KNOWLEDGE_BASE_ID
      : projects.get(sourceProjectRef).id;
    const metadata = {
      ...content,
      sourceProjectRef,
      fingerprint: buildBugCaseFingerprint(content),
      reviewedBy: reviewStatus === 'candidate' ? null : 'local-user',
      reviewReason: reviewStatus === 'candidate' ? null : 'eval fixture',
      reviewedAt: reviewStatus === 'candidate' ? null : 2_000
    };
    const documentText = renderBugCaseDocument(content);
    store.insertBugCaseDocument({
      id,
      knowledgeBaseId,
      name: `${content.title}.bug.md`,
      content: documentText,
      metadata,
      createdAt: 1_000,
      updatedAt: 1_000
    });
    store.replaceDocumentChunks(id, [{
      id: `chunk-${id}`,
      documentId: id,
      documentName: `${content.title}.bug.md`,
      knowledgeBaseId,
      headingPath: [content.title],
      text: documentText,
      tokens: tokenize(documentText),
      embedding: deterministicEmbedding(documentText),
      kind: 'markdown-section',
      chunkIndex: 0
    }]);
    store.updateDocumentStatus(id, 'ready');
    if (reviewStatus !== 'candidate') {
      store.reviewBugCaseDocument(id, {
        reviewStatus,
        metadata,
        updatedAt: 2_000
      });
    }
  }

  const knowledgeService = createKnowledgeService({
    store,
    embeddingClient: {
      async embed(text) {
        if (!vectorAvailable) throw new Error('vector intentionally unavailable');
        return deterministicEmbedding(text);
      }
    },
    embeddingModel: 'bug-eval-embedding',
    logger: { error() {} }
  });
  return {
    store,
    service: createBugKnowledgeService({ store, knowledgeRetrieval: knowledgeService })
  };
}

test('fixed Bug RAG fixture reaches Recall@5 1.0 and MRR at least 0.75', async (t) => {
  const { service } = createEvalService(t);
  const reciprocalRanks = [];
  let recalled = 0;
  let positives = 0;
  const forbidden = new Set(['bug-candidate-eaddr-noise', 'bug-rejected-hydration-noise']);

  for (const query of fixture.queries) {
    const result = await service.searchBugCases({ ...query, topK: 5 });
    const ids = result.results.map(({ bugCase }) => bugCase.id);
    assert.equal(ids.some((id) => forbidden.has(id)), false, query.id);

    if (query.noHit) {
      assert.ok(ids.length === 0 || result.trace.evidenceGap, query.id);
      continue;
    }
    positives += 1;
    if (query.ambiguous) {
      assert.equal(result.trace.ambiguous, true, query.id);
      assert.ok(query.acceptableIds.every((id) => ids.includes(id)), query.id);
      const firstAcceptable = ids.findIndex((id) => query.acceptableIds.includes(id));
      if (firstAcceptable >= 0 && firstAcceptable < 5) recalled += 1;
      reciprocalRanks.push(firstAcceptable >= 0 ? 1 / (firstAcceptable + 1) : 0);
      continue;
    }
    const rank = ids.indexOf(query.expectedId);
    if (rank >= 0 && rank < 5) recalled += 1;
    reciprocalRanks.push(rank >= 0 ? 1 / (rank + 1) : 0);
    if (query.highSignal) assert.ok(rank >= 0 && rank < 5, query.id);
    if (query.id.startsWith('exact-')) assert.equal(rank, 0, query.id);
  }

  const recallAt5 = recalled / positives;
  const mrr = reciprocalRanks.reduce((sum, value) => sum + value, 0) / reciprocalRanks.length;
  assert.equal(recallAt5, 1);
  assert.ok(mrr >= 0.75, `MRR=${mrr}`);
});

test('exact and FTS Bug retrieval still works when vector embedding is unavailable', async (t) => {
  const { service } = createEvalService(t, { vectorAvailable: false });
  const result = await service.searchBugCases({
    query: "TypeError: Cannot read properties of undefined (reading 'map')",
    projectRef: 'project-vue',
    includeCommon: true,
    topK: 5
  });
  assert.equal(result.results[0].bugCase.id, 'bug-vue-map-response');
  assert.deepEqual(result.trace.degradedChannels, ['vector']);
});
