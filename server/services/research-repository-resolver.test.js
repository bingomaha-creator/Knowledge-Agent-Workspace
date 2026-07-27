import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchRepositoryResolver } from './research-repository-resolver.js';

test('repository resolver queries the fixed GitHub API and preserves star-ranked roots', async () => {
  let requested;
  const resolver = createResearchRepositoryResolver({
    fetchImpl: async (url, options) => {
      requested = { url: url.toString(), options };
      return Response.json({
        items: [
          {
            full_name: 'Aider-AI/aider',
            html_url: 'https://github.com/Aider-AI/aider',
            description: 'AI pair programming in your terminal.',
            stargazers_count: 40000
          },
          {
            full_name: 'someone/aider-fork',
            html_url: 'https://github.com/someone/aider-fork',
            description: 'A fork.',
            stargazers_count: 1
          }
        ]
      });
    }
  });

  const results = await resolver.resolveRepositories({ subject: 'Aider' });
  const url = new URL(requested.url);
  assert.equal(url.origin + url.pathname, 'https://api.github.com/search/repositories');
  assert.equal(url.searchParams.get('q'), 'Aider in:name');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(results[0].url, 'https://github.com/Aider-AI/aider');
  assert.equal(results[0].providerRank, 1);
  assert.equal(results[0].sourceKind, 'official_repo');
});

test('repository resolver rejects non-root GitHub URLs from an invalid payload', async () => {
  const resolver = createResearchRepositoryResolver({
    fetchImpl: async () => Response.json({
      items: [{
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo/issues/1',
        description: 'not a repository root'
      }]
    })
  });
  assert.deepEqual(await resolver.resolveRepositories({ subject: 'repo' }), []);
});
