# Phase 09 PRD: Transactions Workspace

## Problem
The current “View all transactions” experience is too constrained for real review work. It should be a full workspace with filterable totals, reliable amount visibility, and enough controls to answer questions like “what were the largest Draft Sharks Entertainment purchases?”

## Users
- Business owner investigating unusual transactions.
- Accountant reviewing receipts, categories, and direction.
- Operator validating that imported transaction data is complete.

## Requirements
- Replace the dashboard modal path with a dedicated Transactions view.
- Preserve dashboard context when opening the view: business, accounts, date range, and search query.
- Support filters for business, account, category, receipt status, direction, date range, and free-text search.
- Support pagination via `limit` and `offset`.
- Support sorting by date, amount, merchant, business, category, and account.
- Provide rollups matching the current filters: inflow, operating outflow, net, transfer movement, row count, and missing receipts.
- Keep long merchant/activity names truncated so amounts remain visible at every viewport.

## Acceptance Criteria
- Dashboard “View all” opens the Transactions workspace rather than a popup modal.
- The workspace can filter to Draft Sharks + Entertainment and sort by largest outflow.
- Rollup totals change with filters and correctly separate inflows, operating outflows, and transfers.
- The table remains readable with very long transaction names.

## Out Of Scope
- Inline bulk edit workflows.
- Infinite scrolling.
- Saved views.

## Test Plan
- Unit test transaction filter/rollup helpers.
- Typecheck frontend API and domain types.
- Browser-check dashboard navigation and the Transactions page at desktop and mobile widths.
