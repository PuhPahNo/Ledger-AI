# Audit Export Runbook

## What Exports Include
- `transactions.csv`
- `receipts.csv`
- `categories.csv`
- `category-rules.csv`
- `manifest.json`
- `receipt-files/*` originals, when present

## How To Export
1. Log in as an admin.
2. Open Admin.
3. Queue a date-range export.
4. Wait for status `ready`.
5. Download the generated ZIP from the export detail endpoint or UI.

## Recovery Notes
- Postgres is the source of truth for transaction and receipt metadata.
- R2/local storage is the source of truth for receipt originals and export ZIPs.
- If a receipt file is missing during export, the ZIP includes a `MISSING.txt` marker for that receipt.
