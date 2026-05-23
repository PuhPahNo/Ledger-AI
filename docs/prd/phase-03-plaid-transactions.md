# Phase 03 PRD: Plaid Transactions

## Goal
Connect bank and card accounts through Plaid, sync transactions into Ledger AI, and map accounts/transactions to businesses and categories.

## Requirements
- Create Plaid Link tokens and exchange public tokens for encrypted access tokens.
- Store Plaid items, accounts, cursors, and transactions.
- Use `/transactions/sync` for cursor-based updates.
- Handle Plaid transaction webhooks by queueing background sync jobs.
- Allow account-to-business assignment.
- Categorize synced transactions with business-aware rules.
- Preserve pending state and reconcile modified/removed transactions.

## Acceptance Criteria
- Plaid sandbox connection creates a `connections` row and synced `accounts`/`transactions`.
- Repeated syncs are idempotent by Plaid transaction ID.
- Webhook payloads enqueue sync jobs.
- Dashboard transactions are sourced from Postgres in real API mode.
