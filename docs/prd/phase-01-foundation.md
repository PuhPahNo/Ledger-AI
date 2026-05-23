# Phase 01 PRD: Foundation

## Goal
Turn Ledger AI from a frontend prototype into a deployable full-stack app with a typed Node/Fastify backend, Postgres schema, migrations, seed data, shared API contracts, and Render deployment configuration.

## Requirements
- Backend serves `/api/*` and the built Vite app from the same Render web service.
- Database uses Render managed Postgres with migrations in `server/db/migrations`.
- Dev data can be seeded with three businesses, categories, rules, sample transactions, and an admin user.
- Frontend mock mode remains available through `VITE_USE_MOCK_API=true`.
- Real mode uses cents-based backend responses and maps them to display dollars in the API layer.

## Acceptance Criteria
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- `npm run db:migrate && npm run db:seed` prepares a fresh database.
- `npm run dev:backend` starts the API on port 8787.
- `render.yaml` defines the web service and Postgres database; the web service can run the
  background job loop with `RUN_WORKER_IN_WEB=true` for a simpler internal deployment.
