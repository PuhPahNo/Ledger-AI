# Phase 12 PRD: Owner And Accountant Insights

## Problem
Ledger AI should answer common owner and accountant questions without making users export data or manually filter raw transactions every time.

## Users
- Owner looking for the biggest purchases, revenue movement, and unusual spend.
- Accountant reviewing uncategorized spend, missing receipts, and transfer volume.
- Stakeholder preparing a monthly close conversation.

## Requirements
- Add an Insights view focused on decision-support, not full accrual accounting.
- Show top purchases by business/category.
- Show uncategorized spend and missing receipt counts.
- Show income by business.
- Show transfer movement separately from operating spend.
- Show a monthly close summary for the selected period.
- Reuse existing exporter patterns for CSV when straightforward.

## Acceptance Criteria
- Users can answer top-purchase, uncategorized, receipt, income, transfer, and monthly-close questions from one view.
- Insights respect business, account, and date filters.
- Transfer totals are visible but not mixed into operating spend.

## Out Of Scope
- Audit-ready financial statements.
- AI-generated tax advice.
- Multi-entity consolidation rules beyond existing business filters.

## Test Plan
- Unit test insight aggregation helpers.
- Typecheck API/domain additions.
- Browser-check the Insights view with realistic long merchant/category names.
