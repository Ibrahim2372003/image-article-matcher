-- 001_init.sql
-- Complete schema. `embeddings.vector` is VECTOR(768): the locked
-- dimension of gemini-embedding-001 at outputDimensionality 768 (see
-- src/config.js, the runtime source of truth; a test asserts this file
-- and that constant agree).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE images (
  id SERIAL PRIMARY KEY,
  storage_path TEXT NOT NULL UNIQUE,
  original_filename TEXT,
  category_hint TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'classified', 'embedded', 'matched', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE articles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  category TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'embedded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every AI call, successful or not. Cost columns are ESTIMATES only:
--   estimated_cost_usd  computed from published per-token rates; NULL
--                       when no rate is configured for the model
--   cost_basis          how that number was derived (never "actual")
--   tokens_estimated    true when token counts were estimated locally
--                       (e.g. chars/4) rather than reported by the API
-- There is deliberately no "actual cost" column: billing state cannot be
-- verified from the API, so this schema does not pretend to know it.
CREATE TABLE model_calls (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('vision_classify', 'embed')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tokens_estimated BOOLEAN NOT NULL DEFAULT false,
  estimated_cost_usd NUMERIC(12, 8),
  cost_basis TEXT NOT NULL DEFAULT 'no_rate_configured'
    CHECK (cost_basis IN ('published_rate_estimate', 'no_rate_configured')),
  success BOOLEAN NOT NULL,
  error_message TEXT
);
CREATE INDEX idx_model_calls_started ON model_calls(started_at);

CREATE TABLE classifications (
  id SERIAL PRIMARY KEY,
  image_id INTEGER NOT NULL REFERENCES images(id),
  category TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  raw_model_output JSONB NOT NULL,
  model_call_id INTEGER NOT NULL REFERENCES model_calls(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_classifications_image ON classifications(image_id);

-- One shared table for image and article embeddings: both live in the
-- same 768-dim space from the same model, so one vector index serves
-- both and a similarity query never UNIONs two tables.
CREATE TABLE embeddings (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('image', 'article')),
  owner_id INTEGER NOT NULL,
  vector VECTOR(768) NOT NULL,
  model TEXT NOT NULL,
  model_call_id INTEGER NOT NULL REFERENCES model_calls(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);
CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (vector vector_cosine_ops);

CREATE TABLE matching_suggestions (
  id SERIAL PRIMARY KEY,
  image_id INTEGER NOT NULL REFERENCES images(id),
  article_id INTEGER NOT NULL REFERENCES articles(id),
  similarity_score REAL NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('match', 'reject')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (image_id, article_id)
);
CREATE INDEX idx_matching_suggestions_image ON matching_suggestions(image_id);
CREATE INDEX idx_matching_suggestions_article ON matching_suggestions(article_id);

CREATE TABLE mismatch_reasons (
  id SERIAL PRIMARY KEY,
  suggestion_id INTEGER NOT NULL REFERENCES matching_suggestions(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,
  human_explanation TEXT NOT NULL,
  signal_values JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mismatch_reasons_suggestion ON mismatch_reasons(suggestion_id);

CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_status_run_after ON jobs(status, run_after);

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  suggestion_id INTEGER NOT NULL REFERENCES matching_suggestions(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  notes TEXT NOT NULL CHECK (length(trim(notes)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reviews_suggestion ON reviews(suggestion_id);
