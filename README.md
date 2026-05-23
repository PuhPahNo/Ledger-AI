# Ledger AI

Internal spend tool for three businesses (Aurora Studio, Meridian Holdings, Kiln Coffee Co.) —
a stripped-down Ramp built around the **Bento Color** direction from the design handoff.

This repo now contains the Ledger AI frontend, Fastify backend, Postgres schema, worker, and
deployment blueprint. The UI still supports mock mode for design/dev work, and switches to the
real backend by setting `VITE_USE_MOCK_API=false`.

---

## Quickstart

```bash
npm install
cp .env.example .env       # fill in secrets + provider credentials as needed
npm run dev                # http://localhost:5173
```

Backend dev:

```bash
npm run db:migrate
npm run db:seed
npm run dev:backend        # http://localhost:8787
npm run dev:worker
```

Type-check without building:

```bash
npm run typecheck
```

Production build and tests:

```bash
npm test
npm run build && npm run preview
```

---

## Project layout

```
src/
├── main.tsx               # React entry
├── App.tsx
├── theme/tokens.ts        # Bento palette + fonts + radii (single source of truth)
├── types/domain.ts        # UI-facing shapes the backend must map to
├── api/                   # Data layer — the only thing that knows about HTTP
│   ├── client.ts          # fetch wrapper, ApiError, useMockApi flag
│   ├── mocks.ts           # Fixture data; mirrors the design's shared-data
│   ├── businesses.ts      # GET /businesses
│   ├── transactions.ts    # GET /transactions, POST /transactions/:id/receipt
│   ├── categories.ts      # GET /categories
│   ├── connections.ts     # GET /connections, Plaid + Gmail link flows
│   ├── alerts.ts          # GET /alerts, POST /alerts/:id/dismiss
│   ├── receipts.ts        # POST /receipts (multipart upload + OCR)
│   ├── summary.ts         # GET /summary
│   └── index.ts           # barrel
├── hooks/useDashboard.ts  # one fan-out hook for the whole dashboard
├── lib/                   # Pure helpers
│   ├── format.ts          # money + percent display
│   └── calc.ts            # totals, counts — kept pure & easily testable
└── components/
    ├── Dashboard.tsx      # composes the bento grid
    ├── HeaderBar.tsx
    └── tiles/             # Tile primitive + one component per bento cell
        ├── Tile.tsx
        ├── Sparkline.tsx
        ├── Donut.tsx
        ├── SpendHeroTile.tsx
        ├── BusinessTile.tsx
        ├── ReceiptDropTile.tsx
        ├── ActivityTile.tsx
        ├── CategoriesTile.tsx
        ├── ConnectionsTile.tsx
        └── AlertsTile.tsx
```

---

## How this was built (pragmatic notes)

A few principles drove the structure — worth knowing before you make a change.

**Tracer-bullet API layer.** Every dashboard read goes through `src/api/*`. Today those modules
resolve to fixtures from `mocks.ts`; tomorrow they hit `/api/*`. The UI never imports `mocks.ts`
directly — components depend on the API contract, not the data source. Backend ready? Set
`VITE_USE_MOCK_API=false` in `.env` and the same components light up against real data.

**One source of truth for everything that repeats.** Colors live in `theme/tokens.ts`. Money
formatting lives in `lib/format.ts`. Domain shapes live in `types/domain.ts`. Tile geometry
lives in the single `Tile` primitive. Change once, ripple everywhere.

**Orthogonal modules.** A tile component doesn't know how data is loaded. The `useDashboard`
hook doesn't know what's rendered. The API layer doesn't know what hook calls it. You can
rewrite any layer in isolation.

**Design by contract via TypeScript.** Every API function is typed end-to-end. Backend devs
read `src/types/domain.ts` + the comments in `src/api/*` to know exactly what the UI expects.
See **[BACKEND.md](./BACKEND.md)** for the full endpoint spec.

**No premature abstraction.** No state library, no data-fetching library, no form library, no
component kit. When `useDashboard` outgrows `useEffect`, swap it for React Query — the call
sites won't move. When the inline styles get heavy, lift them to CSS modules — the tokens
don't move.

---

## Backend integration

Read **[BACKEND.md](./BACKEND.md)** for API contracts and integration notes. The backend includes
real routes, migrations, provider adapters, a Postgres-backed job queue, auth, audit exports, and
storage abstraction. Live Plaid, Gmail, OpenAI, and R2 behavior requires production credentials.

Phase PRDs live in `docs/prd/`; deployment and audit runbooks live in `docs/runbooks/`.

---

## Design handoff

The original Claude Design bundle lives in `_design/ledger-ai/` (gitignored). The Bento
direction in `_design/ledger-ai/project/designs/bento.jsx` was the source of truth for layout
and palette. The HTML/JSX in there is a prototype, not the production code — this codebase is
the production port.
