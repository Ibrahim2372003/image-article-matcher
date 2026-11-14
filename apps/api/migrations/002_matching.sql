-- 002_matching: storage the matching milestone genuinely needs and 001 lacks.
--  * image_classifications : validated vision output per image (avoids re-calling the AI per candidate)
--  * article_embeddings    : article vectors, so pgvector can rank candidate articles for an image
--  * analysis_jobs columns : guard signals (rank/margin/shared tags, also for ACCEPTED matches) and the
--                            embedding model the two vectors came from.
-- Match results themselves are stored as analysis_jobs rows so reviews and the audit trail keep working.

CREATE TABLE image_classifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id     uuid        NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  category     text        NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  tags         text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  confidence   double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provider     text        NOT NULL CHECK (char_length(provider) > 0),
  model        text        NOT NULL CHECK (char_length(model) > 0),
  raw_output   jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_classifications_image_provider_model_key UNIQUE (image_id, provider, model)
);
CREATE INDEX image_classifications_image_idx ON image_classifications (image_id, created_at DESC);

-- Keep vector(768) in sync with EMBEDDING_DIMENSION in @iam/shared.
CREATE TABLE article_embeddings (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id       uuid         NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  embedding        vector(768)  NOT NULL,
  embedding_model  text         NOT NULL CHECK (char_length(embedding_model) > 0),
  task_type        text         NOT NULL CHECK (char_length(task_type) > 0),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT article_embeddings_article_model_key UNIQUE (article_id, embedding_model)
);
CREATE INDEX article_embeddings_embedding_hnsw ON article_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE analysis_jobs
  ADD COLUMN guard_signals   jsonb,
  ADD COLUMN embedding_model text;
