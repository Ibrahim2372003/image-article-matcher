-- 001_init: core schema. Job STATUS (workflow state) is deliberately separate from the guard DECISION.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TABLE articles (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  body          text        NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 50000),
  category      text        CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 100),
  tags          text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 30),
  content_hash  text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT articles_content_hash_key UNIQUE (content_hash)
);
CREATE TRIGGER articles_set_updated_at BEFORE UPDATE ON articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE images (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256        text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type     text        NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size     integer     NOT NULL CHECK (byte_size > 0),
  storage_path  text        NOT NULL CHECK (char_length(storage_path) BETWEEN 1 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT images_sha256_key UNIQUE (sha256)
);

-- The vector dimension is fixed by the column type; keep in sync with EMBEDDING_DIMENSION in @iam/shared.
CREATE TABLE image_embeddings (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id         uuid         NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  embedding        vector(768)  NOT NULL,
  embedding_model  text         NOT NULL CHECK (char_length(embedding_model) > 0),
  task_type        text         NOT NULL CHECK (char_length(task_type) > 0),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT image_embeddings_image_model_key UNIQUE (image_id, embedding_model)
);
CREATE INDEX image_embeddings_embedding_hnsw ON image_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE analysis_jobs (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id          uuid         NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  image_id            uuid         NOT NULL REFERENCES images (id) ON DELETE RESTRICT,
  idempotency_key     text         NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),

  -- workflow state
  status              text         NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'needs_review')),
  attempts            integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        integer      NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  last_error_code     text,
  last_error_message  text,

  -- model prediction (untrusted AI output, schema-validated before storage) vs deterministic policy decision
  model_provider      text,
  model_name          text,
  model_prediction    jsonb,
  similarity          double precision CHECK (similarity IS NULL OR similarity BETWEEN -1 AND 1),
  decision            text         CHECK (decision IS NULL OR decision IN ('accept', 'reject', 'review')),
  decision_confidence double precision CHECK (decision_confidence IS NULL OR decision_confidence BETWEEN 0 AND 1),
  decision_reasons    jsonb        NOT NULL DEFAULT '[]'::jsonb,
  policy_version      text,
  policy_config       jsonb,

  -- usage / cost
  input_tokens        integer      CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       integer      CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd  numeric(12, 6) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),

  queued_at           timestamptz  NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT analysis_jobs_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT analysis_jobs_attempts_le_max CHECK (attempts <= max_attempts),
  CONSTRAINT analysis_jobs_decision_required CHECK (status NOT IN ('completed', 'needs_review') OR decision IS NOT NULL),
  CONSTRAINT analysis_jobs_needs_review_is_review CHECK (status <> 'needs_review' OR decision = 'review'),
  CONSTRAINT analysis_jobs_decision_has_policy CHECK (decision IS NULL OR policy_version IS NOT NULL),
  CONSTRAINT analysis_jobs_failed_has_error CHECK (status <> 'failed' OR last_error_code IS NOT NULL)
);
CREATE TRIGGER analysis_jobs_set_updated_at BEFORE UPDATE ON analysis_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX analysis_jobs_status_queued_idx ON analysis_jobs (status, queued_at);
CREATE INDEX analysis_jobs_needs_review_idx ON analysis_jobs (queued_at) WHERE status = 'needs_review';
CREATE INDEX analysis_jobs_article_idx ON analysis_jobs (article_id);
CREATE INDEX analysis_jobs_image_idx ON analysis_jobs (image_id);

-- At most one human review per job: a second concurrent approve/reject violates the unique constraint.
CREATE TABLE reviews (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        NOT NULL REFERENCES analysis_jobs (id) ON DELETE RESTRICT,
  reviewer    text        NOT NULL CHECK (char_length(btrim(reviewer)) BETWEEN 1 AND 100),
  decision    text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  notes       text        NOT NULL CHECK (char_length(btrim(notes)) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_job_id_key UNIQUE (job_id)
);

-- Append-only audit history (enforced by trigger below).
CREATE TABLE job_audit_events (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id        uuid        NOT NULL REFERENCES analysis_jobs (id) ON DELETE RESTRICT,
  event_type    text        NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  actor         text        NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 100),
  from_status   text,
  to_status     text,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_audit_events_job_idx ON job_audit_events (job_id, created_at);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_audit_events is append-only';
END $$;
CREATE TRIGGER job_audit_events_append_only BEFORE UPDATE OR DELETE ON job_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER job_audit_events_no_truncate BEFORE TRUNCATE ON job_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
