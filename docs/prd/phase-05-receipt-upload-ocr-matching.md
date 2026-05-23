# Phase 05 PRD: Receipt Upload, OCR, And Matching

## Goal
Accept uploaded receipt images/PDFs, extract structured receipt data, and match receipts to transactions automatically when confidence is high.

## Requirements
- Uploads accept image/PDF files up to 25 MB.
- Store originals in local storage for dev and Cloudflare R2 in production.
- Use OpenAI vision Structured Outputs for image receipt extraction.
- Persist extracted merchant, date, total cents, tax cents, payment hints, confidence, and raw OCR JSON.
- Score transaction candidates by business, amount, date, merchant similarity, and account/card hints.
- Auto-attach high-confidence matches and queue ambiguous matches for review.

## Acceptance Criteria
- Upload creates a receipt row and queues extraction.
- Extraction works with OpenAI when configured and falls back safely in dev.
- Matching unit tests cover strong and weak matches.
- Transaction receipt status updates after accepted matches.
