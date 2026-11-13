# Build log

## Milestone 1 — Repository foundation (2026-11-13)

- Inspected repo: branch `main`, remote `origin` (HTTPS), 2 commits. Not empty: held a JS prototype nested in `image-article-matcher/`.
- Decision: preserve it via `git mv` to `legacy/v0-js/` rather than overwrite or delete; port incrementally (`docs/legacy-migration.md`).
- Decision: npm workspaces (pnpm not installed in the build environment); lockfile committed.
- Created `packages/shared` (constants, Zod schemas ported from prototype), `apps/api` (env validation, Express app, `/health`), `apps/web` (Vite/React shell), `infra/docker-compose.yml`, ESLint/Prettier/Vitest config, `.env.example`.
- Known blockers: no Docker in the build environment; no GitHub write credentials were available (see EVIDENCE.md).
- Next: Milestone 2 — DB schema, migrations, Docker infra.
