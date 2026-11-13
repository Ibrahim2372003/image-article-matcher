# Evidence

Only items marked VERIFIED were actually run (build sandbox, Node v22.23.4, npm 10.9.9, 2026-11-13).

| Item                                                   | Status     | Evidence                                              |
| ------------------------------------------------------ | ---------- | ----------------------------------------------------- |
| `npm run typecheck` (shared, api, web)                 | VERIFIED   | exit 0                                                |
| `npm run lint` (ESLint)                                | VERIFIED   | exit 0, no output                                     |
| `npm run format:check` (Prettier)                      | VERIFIED   | "All matched files use Prettier code style!"          |
| `npm test` (Vitest)                                    | VERIFIED   | 3 files, 15 tests passed (mock-free unit tests only)  |
| `npm run build` (shared, api, web/Vite)                | VERIFIED   | web build emitted `dist/`                             |
| API `GET /health` and 404 envelope against running server | VERIFIED | curl returned 200 + valid JSON, 404 error envelope    |
| Docker Compose (PostgreSQL/pgvector, Redis)            | UNVERIFIED | no Docker in build environment                        |
| Database migrations                                    | UNVERIFIED | not yet written for the new layout (milestone 2)      |
| Gemini / Ollama integration                            | UNVERIFIED | not implemented yet; legacy code never run            |
| Legacy prototype (`legacy/v0-js`)                      | UNVERIFIED | not executed; its test/eval dirs are missing          |
| Evaluation metrics, dataset licenses                   | NONE       | no dataset or evaluation exists yet                   |
| Push to GitHub `main`                                  | FAILED     | `fatal: could not read Username for https://github.com` (no credentials in sandbox); commit exists locally only |
