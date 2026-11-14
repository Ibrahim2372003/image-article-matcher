# Mismatch Guard policy and semantic matching (milestone 4)

Code: `apps/api/src/matching/`. Policy version: `guard-v1` (stored with every decision).

## The guard (`guard.ts`)

A **pure, deterministic** function: `evaluateMatch(input, config) -> { decision, primaryReasonCode, reasons[], signals, policyVersion }`. No AI, no network, no clock. A model output reaches the decision only as a number that is compared against a threshold.

Every rule is evaluated and **every** failing rule is reported with a machine-readable code, a human explanation, and the exact signal values.

| Code | Fails when | Severity |
| --- | --- | --- |
| `LOW_CLASSIFICATION_CONFIDENCE` | classification confidence is not a number in [0,1], or `< minConfidence` | review |
| `BELOW_SIMILARITY_THRESHOLD` | similarity is not a valid cosine value in [-1,1], or `< minSimilarity` | reject |
| `CATEGORY_MISMATCH` | both categories present and different, and shared tags `< minSharedTags` | reject |
| `AMBIGUOUS_MATCH` | rank 1 with a runner-up and margin is not a finite number `>= minMargin` | review |

Decision: any `reject`-severity reason -> **reject**; otherwise any `review`-severity reason -> **review** (a human decides); otherwise **accept**. `primaryReasonCode` is the first reason (in the table order) that has the decisive severity.

Boundary rule: a value exactly **at** a threshold passes. `NaN`, `Infinity` and out-of-range scores always FAIL their rule (checks are written `!(valid && x >= min)`), so invalid numbers can never be accepted. Structurally invalid calls (rank not a positive integer, scores that are not numbers) throw `GuardInputError`; callers must treat that as a failure, never as approval.

Categories and tags are normalized: NFKC, trimmed, whitespace-collapsed, lowercased, de-duplicated; non-strings are ignored.

### Configuration (validated, `GuardConfigSchema`)

| Setting | Default | Env override | Range |
| --- | --- | --- | --- |
| `minConfidence` | 0.5 | `GUARD_MIN_CONFIDENCE` | 0..1 |
| `minSimilarity` | 0.6 | `GUARD_MIN_SIMILARITY` | -1..1 |
| `minMargin` | 0.02 | `GUARD_MIN_MARGIN` | 0..2 (0 tolerates ties) |
| `minSharedTags` | 1 | `GUARD_MIN_SHARED_TAGS` | integer 0..100 |

**The defaults are uncalibrated starting points.** They have not been measured against real provider embeddings; calibrate with the evaluation command (milestone 7). Invalid values are rejected at load time, never silently weakened.

The guard does not produce a calibrated probability. `signals` carry the raw values (confidence, similarity, rank, margin, shared tags); a calibrated decision confidence is deferred to evaluation.

## Matching (`service.ts`)

`generateMatches({ store, imageId, embeddingModel, taskType?, guardConfig?, topK?, force? })`:

1. image must exist and have a classification and an embedding, else a typed permanent error (`ImageNotFoundError`, `MissingPrerequisiteError`).
2. Candidates: pgvector cosine nearest articles (`<=>`, similarity = 1 - distance), restricted to embeddings in the **same embedding space = model + task type**. Vectors from different models or task types are never compared (`IncompatibleEmbeddingModelError`).
3. Every candidate goes through the guard; accepted, rejected and needs-review results are all persisted.
4. Persistence is **one transaction**: a failing run stores nothing.

No AI call happens during matching. Filenames and keywords are never consulted.

### Storage

Results are `analysis_jobs` rows (idempotency key `suggest:<imageId>:<articleId>`), so the existing review workflow and audit trail apply unchanged: decision `accept|reject` -> status `completed`; decision `review` -> status `needs_review`. Each save writes a `job_audit_events` row. Columns used: `similarity` (NULL when the score is not finite), `decision`, `decision_reasons` (array of reason objects), `policy_version`, `policy_config`, `guard_signals` (rank, margin, shared tags, task type, primary reason), `embedding_model`, `model_provider/model_name/model_prediction` (the classification).

Re-running: without `force` an image that already has results is skipped. With `force`, unreviewed rows are re-evaluated in place; a row that has a human review is **never** modified. The row is locked before the review check, so a review committing concurrently is always seen. Rows no longer in the top-K are left as they were (stale rows are not deleted, to keep the audit trail).

### Preparation (`prepare.ts`)

`ensureImageClassification`, `ensureImageEmbedding`, `ensureArticleEmbedding` call the AI provider layer (validated) and store results idempotently. Image and article embeddings use the same provider model and the same task type (`SEMANTIC_SIMILARITY`). Images are embedded from their classification text, not pixels.

## Limitations

- Nothing yet calls these functions from an API endpoint or background job (milestones 5-6); end-to-end behaviour is verified by tests only.
- Similarity from the mock provider is lexical overlap, not semantics. Real-provider quality is unmeasured.
- `AMBIGUOUS_MATCH` compares against other articles in the corpus. For a corpus with many near-duplicate articles it will send good matches to review; set `minMargin` to 0 to disable.
- HNSW with a `WHERE` filter can lower recall when many models coexist; fine at current scale.
