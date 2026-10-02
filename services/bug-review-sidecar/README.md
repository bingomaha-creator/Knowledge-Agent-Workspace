# Bug Review Sidecar

Manual merged GitHub PR → real material → existing Qwen configuration → editable
review → approval → published Markdown + upstream BM25 case search.

Independent from Research and the old Bug investigation runtime. The formal React
entry is `/bug-review` (published library); import and review: `/bug-review/review`.
Legacy lists redirect here; legacy records display a retirement notice. Old data
is retained separately and is not mapped to new review IDs.

## Setup

Use Python 3.12+ (a broken global python3.11 symlink is not suitable).

```sh
cd services/bug-review-sidecar
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd ../..
npm run dev:with-bug-review-sidecar
```

The launcher loads repository `.env.local` then `.env` without returning secrets
in API responses. Reuses QWEN_API_KEY, QWEN_BASE_URL and QWEN_MODEL. Optional
GITHUB_TOKEN (or GH_TOKEN) is backend only; private PRs require repository Contents,
Pull requests and Issues read access plus any organization approval. Public reads
can work without a token but have lower GitHub limits. Do not paste tokens in PRs,
model inputs or the browser.

Default loopback port 8011; Node BUG_REVIEW_SIDECAR_URL must match
BUG_REVIEW_SIDECAR_PORT if changed. BUG_REVIEW_DATA_DIR optionally selects isolated
storage (default `services/bug-review-sidecar/data`). This directory is ignored.
Run one sidecar worker: local JSON writes use process locks, not distributed locks.
Restart marks interrupted tasks failed; retries are explicit, not automatic.

## API and storage

Node forwards `/api/bug-review/*`; browser never connects to Python directly.
`POST /import {url}` returns an existing review on duplicate URLs, without retry.
`GET /reviews`, `/reviews/:id`, `/library?q=...`, `/library/:id` read persisted data.
`POST /reviews/:id/:operation {revision, document?, notes?}` supports edit, approve,
reject, publish, retry, refresh, regenerate, adopt and discard. Revision prevents
stale edits; active tasks prevent edits. Refresh never overwrites a work稿;
regeneration creates a candidate. Library returns the last published snapshot.

GitHub: at most 10 pages × 100 per collection, 10 explicitly closing Issue references,
160k material characters; Qwen: at most 44k source-text characters, further limited by
QWEN_CONTEXT_WINDOW_TOKENS (default 32768 minus output/schema headroom). No repository clone,
source execution, webhook, full CI logs, arbitrary external pages or repair actions.
Missing bodies, patches, auxiliary fetch errors, CI gaps and budget truncations
remain visible in evidence gaps. Linked issues currently come from explicit closing
references in the PR body; externally managed/development-only associations are
not discovered. Evidence completeness never implies semantic proof. Collection and model budgets
reserve space for background and share the rest across diffs; each truncation is
disclosed. Generated author reports remain verbatim and labelled as unverified;
CI states come from collected checks. Unsupported validation claims are replaced
with missing-evidence wording. Title-only quotes cannot support these claims;
runtime symptoms require an author report rather than a diff-based hypothesis.
Generated impact quotes remain verbatim; otherwise scope lists collected changed
files explicitly without claiming runtime impact. Affected users and severity
remain unconfirmed (`severity=unknown`) until human correction. Generated model
self-scores remain in raw material, without becoming document reliability scores.
Implemented measures require source quotes; advice
is labelled as suggestions. Internal generation evidence is stored in the raw
material snapshot, without changing the frontend document contract. These checks
do not establish semantic truth, and never overwrite existing drafts automatically.

`data/reviews/*.json`: authoritative material, draft, candidate, task, history and
published snapshot; `review_records.json`: upstream audit mirror; `index.sqlite`:
upstream BM25 published index; `markdown/*.md`: local exports. Keep this data private
for private repositories; no old Bug data is read, migrated or deleted.

## Validation

```sh
npm run test:bug-review-sidecar
node --test server/modules/bug-review/routes.test.js
npm run check:react
```

See UPSTREAM.md for retained code, baseline failures and necessary changes.
Real Qwen/GitHub acceptance is distinct from these connector-stub tests; the user
authorized the formal Demo entry after inspecting public PR cases on 2026-10-02.
Private PR acceptance remains pending; incomplete evidence remains labelled.
