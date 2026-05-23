# Phase 04 PRD: Gmail Receipt Discovery

## Goal
Connect controlled Google Workspace Gmail inboxes and discover receipt attachments for matching against transactions.

## Requirements
- OAuth uses `https://www.googleapis.com/auth/gmail.readonly`.
- Store encrypted refresh tokens and minimal message metadata.
- Use Gmail watch with Google Pub/Sub for prompt updates.
- Renew Gmail watches daily through worker jobs.
- Fall back to reconcile/backfill using `history.list` and receipt-like search queries.
- Store receipt files in R2/local storage and avoid storing full email bodies by default.

## Acceptance Criteria
- Gmail OAuth callback creates a Gmail connection.
- Pub/Sub notifications enqueue Gmail sync jobs.
- Backfill imports PDF/image receipt attachments as `receipts`.
- Restricted-scope handling is documented before production launch.
