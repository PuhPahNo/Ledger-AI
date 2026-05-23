# Render Deployment Runbook

## Services
- `ledger-ai-web`: builds the frontend and backend, serves `/api/*` and static assets, and
  processes Postgres-backed background jobs when `RUN_WORKER_IN_WEB=true`.
- `ledger-ai-postgres`: managed Postgres database.

## First Deploy
1. Create the Render Blueprint from `render.yaml`.
2. Add the variables from `.env.example` to the Render web service.
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
