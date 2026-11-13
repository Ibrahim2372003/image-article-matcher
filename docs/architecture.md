# Architecture (milestone 1)

Monorepo with npm workspaces. `@iam/shared` owns constants and Zod schemas and is the single source of truth for API/web types. `@iam/api` loads configuration through a Zod-validated `loadEnv()` that fails fast, and exposes an Express app (`createApp()`) with request IDs and a consistent error envelope. `@iam/web` is a Vite/React shell.

Planned flow (later milestones): validate input → extract image/article info (schema-validated) → embed → compute similarity → deterministic Mismatch Guard → persist decision, usage and audit trail. Failures resolve to `reject`/`review`, never `accept`.

Similarity alone does not prove an image is factually correct.
