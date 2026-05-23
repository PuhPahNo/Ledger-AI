# Render Deployment Runbook

## Services
- `ledger-ai-web`: builds the frontend and backend, serves `/api/*` and static assets.
- `ledger-ai-worker`: processes Postgres-backed background jobs.
- `ledger-ai-postgres`: managed Postgres database.

## First Deploy
1. Create the Render Blueprint from `render.yaml`.
2. Add the variables from `.env.example` to Render. `VITE_*` is needed only on `ledger-ai-web`; the runtime/provider secrets should be present on both web and worker.
3. Run `npm run db:seed` from the web service shell.
4. Reset the admin password with `npm run admin:reset -- --username admin --password <strong-password>`.

## Smoke Test
1. Visit `/healthz`.
2. Log in as the admin user.
3. Open Admin and verify businesses/categories/users load.
4. Queue a month-to-date export.
5. Connect Plaid sandbox and verify transactions sync.
6. Connect a controlled Workspace Gmail account and run a backfill.
7. Upload a receipt image and verify extraction/match jobs run.
