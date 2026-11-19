-- 003_jobs: lifecycle support for submitted analysis jobs (milestone 5).
-- Order matters: add nullable columns, BACKFILL existing rows, then add constraints, so applying this to a
-- database that already holds milestone-4 rows cannot fail on data that was valid before.
--
--  kind                 'suggestion' = milestone-4 match results (key 'suggest:...'); 'submission' = API-submitted jobs
--  request_fingerprint  hash of (article, image) a job was created for; detects idempotency-key reuse with a different payload
--  enqueued_at          set when the job was published to the queue; NULL = publication pending/failed (reconciler input)
--  ai_usage             one row per REAL provider call (success or failure); reused/cached results create no row

ALTER TABLE analysis_jobs
  ADD COLUMN kind text,
  ADD COLUMN request_fingerprint text,
  ADD COLUMN enqueued_at timestamptz;

UPDATE analysis_jobs
   SET kind = CASE WHEN idempotency_key LIKE 'suggest:%' THEN 'suggestion' ELSE 'submission' END;
UPDATE analysis_jobs
   SET request_fingerprint = 'backfill:' || id::text
 WHERE kind = 'submission' AND request_fingerprint IS NULL;

ALTER TABLE analysis_jobs
  ALTER COLUMN kind SET NOT NULL,
  ADD CONSTRAINT analysis_jobs_kind_check CHECK (kind IN ('submission', 'suggestion')),
  ADD CONSTRAINT analysis_jobs_kind_matches_key CHECK ((kind = 'suggestion') = (idempotency_key LIKE 'suggest:%')),
  ADD CONSTRAINT analysis_jobs_submission_fingerprint CHECK (kind = 'suggestion' OR request_fingerprint IS NOT NULL),
  -- An infrastructure/AI failure is not a content decision.
  ADD CONSTRAINT analysis_jobs_failed_no_decision CHECK (status <> 'failed' OR decision IS NULL),
  ADD CONSTRAINT analysis_jobs_open_no_decision CHECK (kind = 'suggestion' OR status NOT IN ('queued', 'processing') OR decision IS NULL);

-- Reconciler: find stale open submissions without scanning the table.
CREATE INDEX analysis_jobs_reconcile_idx ON analysis_jobs (updated_at)
  WHERE kind = 'submission' AND status IN ('queued', 'processing');

-- Guarded transitions, enforced in the database as a second line of defence behind the guarded UPDATEs in code.
--   queued     -> processing | failed
--   processing -> processing (re-claim after a crash) | queued (retry) | completed | needs_review | failed
--   completed | failed | needs_review are terminal for submissions (milestone 6 may relax needs_review explicitly)
CREATE FUNCTION enforce_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'analysis_jobs.kind is immutable';
  END IF;
  IF OLD.kind = 'submission' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'queued'     AND NEW.status IN ('processing', 'failed')) OR
      (OLD.status = 'processing' AND NEW.status IN ('queued', 'completed', 'needs_review', 'failed'))
    ) THEN
      RAISE EXCEPTION 'illegal job status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER analysis_jobs_enforce_transition BEFORE UPDATE ON analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_job_transition();

CREATE TABLE ai_usage (
  id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id             uuid          NOT NULL REFERENCES analysis_jobs (id) ON DELETE RESTRICT,
  attempt            integer       NOT NULL CHECK (attempt >= 1),
  operation          text          NOT NULL CHECK (operation IN ('classify_image', 'embed_image', 'embed_article')),
  provider           text          NOT NULL CHECK (char_length(provider) > 0),
  model              text          NOT NULL CHECK (char_length(model) > 0),
  success            boolean       NOT NULL,
  error_code         text,
  latency_ms         integer       NOT NULL CHECK (latency_ms >= 0),
  input_tokens       integer       CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      integer       CHECK (output_tokens IS NULL OR output_tokens >= 0),
  tokens_estimated   boolean       NOT NULL DEFAULT false,
  -- NULL means UNKNOWN, never zero. A cost exists only when a rate was configured and token counts were reported.
  estimated_cost_usd numeric(16, 8) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  cost_basis         text          NOT NULL CHECK (cost_basis IN ('no_rate_configured', 'tokens_unavailable', 'configured_rate_estimate')),
  created_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_failure_has_code CHECK (success OR error_code IS NOT NULL),
  CONSTRAINT ai_usage_cost_matches_basis CHECK ((cost_basis = 'configured_rate_estimate') = (estimated_cost_usd IS NOT NULL))
);
CREATE INDEX ai_usage_job_idx ON ai_usage (job_id, id);
