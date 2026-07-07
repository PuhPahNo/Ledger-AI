---
name: verify
description: Build/launch/drive recipe for verifying Ledger AI UI changes end-to-end in mock mode.
---

# Verifying Ledger AI changes

## Launch (mock mode — no Postgres needed)

```bash
npm install                       # once per container
VITE_USE_MOCK_API=true npx vite --port 5173 --strictPort &   # http://localhost:5173
```

Mock mode auto-logs-in as a mock admin (`src/App.tsx`), so no auth flow is needed.
Fixtures live in `src/api/mocks.ts` — extend them there if a new feature has no mock data.

## Drive (Playwright)

Chromium is preinstalled at `/opt/pw-browsers/chromium`; install the `playwright` npm
package in a scratch dir (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright`)
and launch with `executablePath: '/opt/pw-browsers/chromium'`.

Navigation is hash-based (`#transactions`, `#cash-flow`, `#admin`, `#receipts`, `#inbox`);
deep-link with `page.goto('http://localhost:5173/#view')`. Admin sections are Radix tabs
(`[role="tab"]`, `hasText`).

## Gotchas

- **Hover targets below the fold:** `boundingBox()` returns viewport coords; scroll the
  element to `block: 'center'` before `page.mouse.move`, or hovers silently miss.
- Expected console noise in the sandbox (not regressions): Google Fonts and
  `cdn.plaid.com` are blocked (→ "Plaid failed to load" toast), and the receipt file
  preview 500s in mock mode because the `/api` proxy has no backend.
- Backend-only changes: `npm run db:migrate && npm run db:seed && npm run dev:backend`
  needs a real Postgres (`DATABASE_URL`); in containers without one, mock mode plus
  route-level reasoning is the available surface.
