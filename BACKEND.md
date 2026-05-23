# Ledger AI — Backend Integration Plan

This document describes the backend the frontend expects. The implementation now lives under
`server/` and can run locally with Postgres. The UI can still use `src/api/mocks.ts`; flip
`VITE_USE_MOCK_API=false` once the backend is running.

---

## Conventions

- **Base URL:** the frontend calls `${VITE_API_BASE}/...`. In dev it's `/api` and Vite proxies
  to `VITE_API_PROXY`. In prod set `VITE_API_BASE` to the backend origin.
- **Auth:** session cookie (`credentials: 'include'` is already set in `src/api/client.ts`).
  Auth on the server is out of scope for this doc — assume the caller is authenticated and
  scoped to a tenant.
- **Tenancy:** every response is implicitly scoped to the caller's user → businesses they can see.
- **Money:** the mock uses dollars as floats. The real backend sends integer cents, and the
  frontend maps cents to display dollars in `src/api/mapper.ts`.
- **Dates:** send ISO 8601 strings. Display strings (`"May 22"`, `"2 min ago"`) belong in the
  frontend; the backend just sends timestamps. (Mock has both `date` and `dateLabel` only so the
  UI matches the prototype today — the real shape drops `dateLabel` and `last`.)
- **Errors:** non-2xx returns plain text. The frontend wraps them in `ApiError` with status code.

---

## Endpoints the UI calls today

The five modules in `src/api/` already wire these up.

### `GET /businesses`
**Returns:** `Business[]` (see `src/types/domain.ts`).
The user's businesses, with brand color used everywhere they appear.

### `GET /summary?period=YYYY-MM`
**Returns:** `SpendSummary`.
Hero tile data: total outflow for the period, MoM delta, trailing-12 sparkline, last/avg months.

### `GET /transactions?biz=&from=&to=&q=&limit=`
**Returns:** `Transaction[]` newest first.
The Activity tile + future search use this. `biz=all` or omit for cross-business.

### `POST /transactions/:id/receipt`
**Body:** `{ receiptId: string }`
**Returns:** the updated `Transaction`.
Used after a receipt upload to attach an OCR'd receipt to a transaction.

### `GET /categories?period=YYYY-MM`
**Returns:** `Category[]` — name, amount, MoM delta string, count.
The donut + legend in the Categories tile.

### `GET /connections`
**Returns:** `Connection[]` — Plaid items (bank + card) and Gmail accounts with health.

### `POST /connections/plaid/link-token`
**Returns:** `{ link_token, expiration }`
Backend asks Plaid for a Link token; frontend hands it to Plaid Link.

### `POST /connections/plaid/exchange`
**Body:** `{ public_token: string }`
**Returns:** the newly created `Connection`.
Frontend forwards the `public_token` Plaid Link produced; backend exchanges it for an
`access_token`, persists the item, and kicks off the first transaction sync.

### `GET /connections/gmail/oauth-url`
**Returns:** `{ url }`
Backend builds the Google OAuth consent URL with the right scopes; frontend redirects.

### `GET /alerts?status=open`
**Returns:** `Alert[]` — duplicate subscriptions, missing receipts, orphan receipts, spikes.

### `POST /alerts/:id/dismiss`
**Returns:** 204.

### `POST /receipts` (multipart/form-data)
**Body:** `file` field with the image or PDF.
**Returns:** `UploadReceiptResult` = `{ receiptId, matched?: Transaction, ocr?: {merchant, total, date} }`
The "snap or drop" tile and the header upload button both call this.

---

## Server-side work

The first production scaffold is implemented:

- Fastify API in `server/routes/*`
- Drizzle schema in `server/db/schema.ts`
- SQL migrations in `server/db/migrations/*`
- Auth/session/TOTP in `server/auth/*`
- Plaid, Gmail, OpenAI receipt extraction, matching, storage, insights, and exports in `server/services/*`
- Postgres-backed jobs in `server/jobs/*`
- Render Blueprint in `render.yaml`

The sections below remain the product behavior contract for hardening and extending the shipped
implementation.

### 1. Plaid — bank and card transaction sync

**Why:** the dashboard's primary data is Plaid transactions across both businesses.

**Server pieces:**
- Plaid `link/token/create` and `item/public_token/exchange` endpoints (wrap with the two
  endpoints above).
- Per-item background sync: `transactions/sync` cursor loop, persist to a `transactions` table.
- Webhook receiver for `TRANSACTIONS` and `DEFAULT_UPDATE` so we don't poll.
- Map Plaid categories → our category taxonomy in a `category_rules` table.
- Reconcile pending → posted transactions; never duplicate.

**Key contract:** every persisted transaction maps cleanly to `Transaction` in
`src/types/domain.ts`. Anything Plaid-specific (account_id, transaction_id, raw category) stays
server-side.

### 2. Gmail — receipt discovery

**Why:** half the receipts already arrive in inboxes; we want them attached automatically.

**Server pieces:**
- Google OAuth with `gmail.readonly` scope; persist refresh tokens.
- Periodic fetch (cron or push via Gmail watch + Pub/Sub) of messages matching receipt-like
  heuristics: `subject:(receipt OR order OR invoice OR confirmation)`, common sender domains.
- For each candidate: extract structured fields (merchant, total, date) via parsing rules per
  sender + LLM fallback. Store as a `receipts` row with `source='gmail'`.
- Match to a transaction (see #3).

### 3. Receipt ↔ transaction matching

**Why:** every receipt — uploaded or from Gmail — should land on the right transaction.

**Algorithm sketch:**
1. Candidate set = transactions for the same business within ±5 days of the receipt date.
2. Score: total match (exact or within 2%), merchant string similarity (normalized), card/account
   match where possible.
3. If top score > confidence threshold: auto-attach, mark `receipt='matched'`.
4. If 0.5 < score < threshold: surface as `receipt='pending'`, show in UI for confirmation.
5. Receipts that match nothing → orphan alert (kind `'orphan'`).
6. Transactions that go N days without a receipt → missing alert (kind `'missing'`).

**Storage:** `receipts(id, business_id, source, merchant, total_cents, receipt_date, file_url, ocr_json, transaction_id NULLABLE)`.

### 4. Receipt upload + OCR

**Why:** powers the "Snap or drop" tile and the header upload button.

**Server pieces:**
- `POST /receipts` accepts multipart; stores the file in object storage (S3/GCS).
- OCR via Textract / Document AI / GPT-4o vision — pick one.
- Normalize OCR result into `{ merchant, total, date }` and pass to the matcher (#3).
- Return `UploadReceiptResult` with the best-guess transaction so the UI can show a confirm.

### 5. Auto-categorization

**Why:** tax-time, and the Categories donut.

**Server pieces:**
- Maintain `category_rules(business_id, match_kind, pattern, category)` where match_kind is one
  of `merchant_contains`, `merchant_exact`, `plaid_category`, `amount_range`.
- On every new transaction: run rules in priority order; first match wins.
- Per-business overrides (Kiln's "Inventory" is different from Aurora's).
- Optional ML fallback (KNN on merchant embedding) for unmatched.
- Surface in the UI via `GET /categories` aggregate and `Transaction.cat`.

### 6. Insights / alerts

**Why:** the FLAGS tile + future weekly digest.

Run periodically (nightly is fine to start):

- **Duplicate subscription** — same normalized merchant billing two businesses in same period.
- **Missing receipt** — `receipt='missing'` past SLA window (e.g. 7 days).
- **Orphan receipt** — receipt unmatched after 14 days.
- **Spend spike** — category MoM delta > +20% AND absolute delta > $500.

Persist each finding as an `Alert` row so dismissal sticks.

---

## Suggested data model (minimal)

```
businesses          (id, name, short, color, hue)
connections         (id, business_id, kind, label, mask?, status, plaid_item_id?, gmail_address?, last_sync_at)
accounts            (id, connection_id, plaid_account_id, kind, mask)            -- Plaid sub-items
transactions        (id, business_id, account_id, date, merchant, amount_cents, category_id, plaid_txn_id, receipt_id?, flag?)
categories          (id, business_id?, name)                                     -- nullable business_id = global default
category_rules      (id, business_id?, match_kind, pattern, category_id, priority)
receipts            (id, business_id, source, merchant?, total_cents?, receipt_date?, file_url?, ocr_json?, transaction_id?)
alerts              (id, business_id?, kind, severity, title, detail, status, payload_json, created_at, dismissed_at?)
```

---

## What's deliberately NOT in the frontend yet

The frontend stays focused on the bento dashboard. These need work but are out of scope until
the backend lands:

- Plaid Link modal flow (only the `createPlaidLinkToken` + `exchangePlaidPublicToken` stubs exist)
- Gmail OAuth redirect handler page
- Receipt-match confirmation UI (uploads succeed; the confirm modal is not built)
- Transaction detail view
- Onboarding flow (connect first bank, connect first Gmail)
- Toast/notification system (receipt upload currently just logs)
- Auth (assumed handled by the surrounding internal-tool platform)

Each of these is small once the backend contract is real; build them as the corresponding API
calls become non-mock.
