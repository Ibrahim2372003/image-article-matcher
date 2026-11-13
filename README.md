# Image–Article Matcher — AI Content Mismatch Guard

Decides whether an image is semantically appropriate for an article (`accept` / `reject` / `review`) using structured AI output plus a deterministic, configurable policy. Model predictions and policy decisions are kept separate; AI failure never counts as approval.

> **Status:** Milestone 1 (foundation) complete. See `BUILDLOG.md` for progress and `EVIDENCE.md` for what has actually been verified.

## Layout

| Path              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `apps/api`        | Node.js + Express + TypeScript API                           |
| `apps/web`        | React + Vite + TypeScript UI                                 |
| `packages/shared` | Shared constants and Zod schemas                             |
| `infra`           | Docker Compose (PostgreSQL + pgvector, Redis)                |
| `scripts`         | Dataset preparation / evaluation (later milestones)          |
| `docs`            | Architecture and migration notes                             |
| `legacy/v0-js`    | Earlier JavaScript prototype, preserved and being ported     |

## Prerequisites

Node.js >= 20.6, npm >= 10, Docker (for PostgreSQL/Redis from milestone 2).

## Setup

```bash
npm install
cp .env.example .env      # keep real keys out of git
npm run typecheck && npm run lint && npm test && npm run build
npm run dev:api           # http://localhost:3000/health
npm run dev:web           # http://localhost:5173
docker compose -f infra/docker-compose.yml up -d   # DB + Redis (milestone 2+)
```

## Troubleshooting

- `Invalid environment configuration`: check `.env` against `.env.example`; `GEMINI_API_KEY` is required when `AI_PROVIDER=gemini`.
- `@iam/shared` not found: run `npm run build -w @iam/shared` (typecheck does this automatically).
