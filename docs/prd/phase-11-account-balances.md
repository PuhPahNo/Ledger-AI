# Phase 11 PRD: Account Balances

## Problem
Users need a quick view of where balances stand now without confusing bank deposits, available balances, and credit-card liabilities. Ledger AI already stores Plaid balances, but the product does not surface them clearly.

## Users
- Owner checking current cash and credit exposure.
- Stakeholder reviewing account coverage and sync health.
- Accountant confirming which accounts are watched or ignored.

## Requirements
- Add an Account Balances view or dashboard section using existing account balance fields.
- Separate depository balances from credit-card balances.
- Show current and available balances by account and business.
- Show connection status, watched/ignored state, and last sync freshness where available.
- Avoid historical trend charts until balance snapshots exist.

## Acceptance Criteria
- Users can see total bank cash, total credit balances, and net cash exposure.
- Each account row shows business, account name, mask, kind, watched state, balances, and connection health.
- The view does not imply historical balance data exists.

## Out Of Scope
- Balance history, cash forecasts, or reconciliation statements.
- Editing Plaid credentials.

## Test Plan
- Unit test balance summary helpers.
- Typecheck account domain/API usage.
- Browser-check row layout for long account names.
