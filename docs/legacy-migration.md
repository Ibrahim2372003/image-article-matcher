# Legacy prototype

The repository already contained a JavaScript prototype (~2,300 lines) uploaded in commit `0ef07fd`, nested at `image-article-matcher/`. It was moved with `git mv` to `legacy/v0-js/` (history preserved, nothing deleted) and is excluded from lint/format/test.

It contains provider abstraction (Gemini/mock), a Mismatch Guard, a Postgres job worker, a pgvector migration, and a cost tracker. Its `package.json` references `eval/` and `test/` directories that do **not** exist in the repo, so its `test`, `eval` and `dataset:build` scripts could not be run. The prototype has not been executed by this build.

Port plan: schemas/constants (done, `packages/shared`), migration -> milestone 2, providers -> 3, guard/matching -> 4, jobs -> 5 (the spec calls for BullMQ; the prototype polls Postgres), routes -> 5/6. Delete `legacy/` only once ported.
