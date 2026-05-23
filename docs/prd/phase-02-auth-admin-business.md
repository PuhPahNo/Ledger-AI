# Phase 02 PRD: Auth, Admin, And Business Setup

## Goal
Protect financial data with local admin authentication and provide an admin surface for businesses, users, categories, rules, connected accounts, audit logs, and export jobs.

## Requirements
- Local username/password auth using Argon2id and HTTP-only session cookies.
- Optional TOTP setup and verification through the UI/API.
- Admin-created users only; no public signup or external password reset.
- Emergency admin reset command available from the Render shell.
- Admin overview exposes businesses, accounts, categories, rules, users, and recent exports.
- Audit log records sensitive admin actions.

## Acceptance Criteria
- Unauthenticated API requests to product routes return 401.
- Admin can log in, log out, view admin overview, queue an export, and enable TOTP.
- `npm run admin:reset -- --username admin --password <new-password>` works.
