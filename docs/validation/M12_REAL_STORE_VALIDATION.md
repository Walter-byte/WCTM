# M12 Real-Store Validation

Date:
Tester:
Environment:
Backend commit:
Bot commit:
WooCommerce store:
Telegram account role:

## Result Summary

- Overall result: NOT STARTED
- Phase 4 closure recommendation: PENDING
- Blocking defects:
- Non-blocking observations:

---
## V0 — Environment Recovery and Readiness

Date:
Environment: Local Docker Compose validation environment

### Recovery performed

- Diagnosed a stale backend Docker image using the incorrect startup command `node backend/dist/main.js`.
- Confirmed the repository Dockerfile uses the correct command `node dist/main.js`.
- Backed up the local PostgreSQL database.
- Backed up the ignored local `.env`.
- Preserved valid existing secrets.
- Added missing documented local-development configuration.
- Generated missing local internal API and callback-signing keys without exposing their values.
- Replaced an invalid legacy encryption key only after confirming that no encrypted Store credentials existed.
- Applied all six pending Prisma migrations using `prisma migrate deploy`.
- Rebuilt and recreated the backend container.
- Rebuilt the Telegram bot because its synchronized internal API key changed.

### Migration state

All eight repository migrations are applied.

Newly applied migrations:

- `20260722142357_store_registration_handshake`
- `20260723120000_woocommerce_webhook_ingestion`
- `20260723180000_order_projection`
- `20260723220000_telegram_account_linking`
- `20260723230000_telegram_order_callback_references`
- `20260724090000_telegram_order_status_write`

### Backend verification

- Working directory: `/app/backend`
- Startup command: `node dist/main.js`
- Restart count: `0`
- `/api/health`: PASS
- `/api/health/readiness`: PASS
- PostgreSQL: PASS
- Redis: PASS
- Startup/configuration/database errors: none detected
- Configured secret leakage in logs: none detected

### Remaining blocker

The existing Telegram BotFather token was rejected by Telegram with `401 Unauthorized`.

The Telegram bot remains stopped until a valid `TELEGRAM_BOT_TOKEN` is placed in the ignored local `.env` and the bot is restarted and verified.

### V0 status

- Backend readiness: PASS
- Full validation readiness: BLOCKED — invalid Telegram bot token

## V1 — OWNER/ADMIN Successful Update

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V2 — MEMBER Denial

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V3 — Invalid or Expired Callback

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V4 — Duplicate Callback

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V5 — Delayed Callback

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V6 — Active Context Changed Before Callback

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V7 — WooCommerce Unreachable Before Confirmation

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V8 — Ambiguous Timeout After Dispatch

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V9 — Authoritative Reconciliation

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V10 — Local Order Projection Update

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V11 — Telegram Message-Edit Failure Fallback

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V12 — Bot/Backend Restart Safety

Status: NOT TESTED

Setup:
Action performed:
Telegram result:
Backend result:
WooCommerce result:
Database result:
Evidence:
Notes:

---

## V13 — Audit and Secret-Leak Review

Status: NOT TESTED

Logs reviewed:
Audit rows reviewed:
Secrets searched:
Evidence:
Notes:

---

## V14 — Duplicate WooCommerce Write Audit

Status: NOT TESTED

Cases reviewed:
Expected write count:
Observed write count:
Database uniqueness evidence:
Evidence:
Notes:

---

## Defects

### DEFECT-001

Severity:
Related validation case:
Description:
Expected:
Actual:
Evidence:
Reproduction steps:
