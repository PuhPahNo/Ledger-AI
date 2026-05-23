# Phase 07 PRD: Audit Export, Hardening, And Launch

## Goal
Ship Ledger AI as an internal production tool with audit-ready exports, secure defaults, deployment docs, and smoke tests.

## Requirements
- Export jobs produce a ZIP containing transactions CSV, receipts CSV, categories/rules CSVs, manifest JSON, and original receipt files.
- Store export ZIPs in the configured storage adapter and provide signed download URLs.
- Add rate limiting, secure cookies in production, token encryption, and audit logs.
- Provide Render deployment and backup/restore runbooks.
- Document production environment variables and smoke test flow.

## Acceptance Criteria
- Fresh Render deploy can migrate, seed/reset admin, log in, and serve the app.
- Export job reaches `ready` and returns a download URL.
- Production checklist covers Plaid, Gmail, OpenAI, R2, Postgres, and secrets.
