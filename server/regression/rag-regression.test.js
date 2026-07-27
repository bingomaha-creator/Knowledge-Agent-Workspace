import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rankKnowledgeChunks } from '../rag-utils.js';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/rag-regression-cases.json'
);

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

for (const scenario of fixture.cases) {
  test(`RAG regression: ${scenario.name}`, () => {
    const results = rankKnowledgeChunks(
      scenario.query,
      scenario.chunks,
      scenario.topK,
      scenario.options
    );
    const resultIds = results.map((result) => result.id);

    for (const expectedId of scenario.expectedIds) {
      assert.ok(
        resultIds.includes(expectedId),
        `${expectedId} should be in top ${scenario.topK}; received ${resultIds.join(', ')}`
      );
    }
  });
}
