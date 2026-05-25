# Phase 10 PRD: Cash Flow Reporting

## Problem
Owners and stakeholders need to understand money in versus money out by month and year. Spend-only dashboards do not answer whether cash flow improved, whether a month beat the same month last year, or which business drove the change.

## Users
- Owner comparing current and prior-year cash movement.
- Business stakeholder checking inflow, outflow, and net cash by business.
- Accountant validating cash-basis movement before deeper bookkeeping.

## Requirements
- Add cash-basis reporting from Plaid transactions.
- Support monthly and annual grouping.
- Support year-over-year comparisons for equivalent periods.
- Default to operating cash flow that excludes transfer categories.
- Provide an all-movement toggle that includes transfers.
- Support business and account filters.
- Show business-segmented totals where the UI has room.

## Acceptance Criteria
- Users can compare March 2026 against March 2025.
- Cash flow totals show inflow, outflow, net, and transfer movement.
- Operating mode excludes `exclude_*` categories; all-movement mode includes them.
- Dashboard navigation exposes the Cash Flow view.

## Out Of Scope
- Forecasting.
- Accrual P&L reporting.
- Balance-sheet categorization.

## Test Plan
- Unit test cash-flow aggregation, date windows, and transfer inclusion rules.
- Typecheck API mappers and domain types.
- Browser-check monthly and annual modes.
