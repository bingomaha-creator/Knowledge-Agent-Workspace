# Insight-agent-yuan migration record

Source: https://github.com/gulugulu33/Insight-agent-yuan
Pinned revision: 2bfa54d6ba8cb3287096b3c5293ac29eaeb624aa

Retained Python modules under src/repo_maintainer: llm_executor, bug_schema,
models, config, log_compressor, review_workflow, wiki_publisher, bm25_index,
flow_debug. The package initializer deliberately does not import the repair
platform. The new API never calls generate_patch or executes repository commands.

Minimal dependencies follow the upstream docs/simplification-guide.md core
runtime option; vector backends, embedding models, repair tools and Vue console
are not required for this pipeline. Active retrieval is the upstream BM25 SQLite
index, not vector or hybrid retrieval.

Original baseline (Python 3.12, isolated data):
- `pytest -q`: fixture sample_repo import collision during collection.
- `pytest -q tests`: 19 passed, 15 failed, largely legacy SkillRepository.match_skills
  missing / old repair policy expectations. Not represented as successful tests.
- Frontend `npm run build`: TS2322 in CiAutofixView.vue:442.
- start_demo.py: four seeded reviews; draft approve rejected by state machine;
  draft publish wrote Markdown before rejecting transition. Search seeded data
  works, but this does not prove PR collection or model extraction.

Migration changes:
- GitHub read-only material collector and focused FastAPI pipeline connect the
  existing generate_bug_review method (the original extraction route called repair).
- Schema adds symptom, validation, evidence completeness/gaps, and root basis;
  incomplete root may have no quote. Locations bind to saved source IDs and exact
  snippets; inference is not a fact check.
- Remove hidden 4k context/10-file truncation from the retained extractor;
  explicit collection/model budgets disclose every truncation in the snapshot.
  Both budgets now reserve background space and share diff space fairly, retaining
  short sources instead of letting the first large file consume all context.
- The retained extractor prompt explains unified diff markers and requests
  generation-only evidence for symptoms, verification and prevention. The pipeline
  preserves raw output before governance, uses author quotes verbatim, renders
  actual CI states, and drops unsupported verification/implemented claims. Title-only
  quotes are excluded from symptom/validation/prevention evidence, and inferred
  symptoms also require a bound quote. Code,
  CI and title-only root evidence cannot promote a generated root cause to fact.
  This is conservative source governance, not semantic entailment verification;
  human editing and approval remain separate and existing snapshots are preserved.
- JSON records and Markdown write atomically; Markdown names use full review ID.
- Case JSON is authoritative for work稿, candidate and published snapshots;
  the original review engine handles allowed approval transitions and provides
  audit records. BM25 only indexes published snapshots and is reconciled on restart.
- Validate approval before exporting/indexing. Existing published snapshot stays
  visible until a revised draft is explicitly approved and published.

Original backend pyproject is retained as UPSTREAM-pyproject.toml for comparison;
this is not the runnable dependency manifest. New HTTP behavior tests cover the
migrated pipeline, rather than claiming the old repair suite passes.
