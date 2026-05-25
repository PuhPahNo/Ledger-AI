# Phase 08 PRD: Data Integrity And History Backfill

## Problem
Ledger AI needs a trustworthy transaction foundation before broader financial reporting can be useful. Existing views must preserve the app sign convention, keep operating spend separate from transfers, and give operators a safe way to backfill 365 days of Plaid history for already linked accounts.

## Users
- Business owner checking whether dashboard totals are believable.
- Accountant reviewing transaction direction, income categories, and transfer treatment.
- Operator running a one-time Render shell backfill for linked Plaid connections.

## Requirements
- Preserve the canonical sign convention: negative amounts are outflows and positive amounts are inflows.
- Exclude transfer/card-payment categories from operating spend totals while keeping those transactions visible in transaction lists and cash-movement reporting.
- Categorize obvious Plaid transfer and business expense signals deterministically before AI categorization.
- Provide read-only audit output for transaction direction, income/category mismatches, transfer volume, and oldest transaction per Plaid connection/account.
- Provide an explicit idempotent 365-day Plaid backfill command for existing connections.
- Never trigger the backfill automatically on Render redeploy.

## Acceptance Criteria
- Spend summary, category, comparison, and stacked business totals exclude categories whose tax code starts with `exclude_`.
- Inflows remain positive through Plaid ingestion, API mapping, and frontend display.
- Transfer/card-payment transactions use receipt status `n/a`.
- A script can print audit totals without mutating the database.
- A script can backfill active Plaid connections with `days_requested=365` only when an operator runs it.

## Out Of Scope
- Accrual accounting, invoice matching, or book-close journal entries.
- Historical balance snapshots.
- Automatic production backfill during deploy.

## Test Plan
- Unit test deterministic categorization and excluded spend-category helpers.
- Unit test Plaid sign conversion/backfill constants where possible.
- Run `npm run typecheck`, `npm test`, and `npm run build`.
- Run the read-only audit command in Render shell after deploy.
