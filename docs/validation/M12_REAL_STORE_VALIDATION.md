# M12 Real-Store Validation Operator Guide

Status: M12-V IMPLEMENTED — RUN PILOT READINESS BEFORE V1

Environment: Approved VPS Docker Compose validation environment behind Caddy

Scope: M12 Telegram order-status write path
Production data: PROHIBITED

This document is the executable validation record for M12. It is based on the
repository implementation as inspected on 2026-07-24.

Run one numbered step at a time. Record `PASS`, `FAIL`, or `BLOCKED`, attach the
requested evidence, and stop on the first blocker. Never invent a workaround,
manually insert application records, mint a JWT from `.env`, or expose a secret.

The Validation Operator must have live access to this repository and a safe
terminal in the local validation environment. A documents-only chat is not an
acceptable operator for this guide.

---

## Today's One-Page Runbook

### Current result

- Infrastructure and migrations: recheck on the approved VPS
- Telegram bot runtime: recheck on the approved VPS
- M12-V supported private-pilot bootstrap: implemented
- WordPress connector: remains a stub and is not used or claimed by M12-V
- V1–V14 real-store execution: begins only after `pilot:readiness` passes

### What Walter must do now

1. Deploy/rebuild the approved VPS stack with `PILOT_MODE=true` and the public
   Caddy HTTPS origin in `PILOT_WEBHOOK_BASE_URL`.
2. Run `docker compose exec backend npm run pilot:setup`.
3. Enter WooCommerce credentials only in the hidden terminal prompts.
4. Paste the one-time `/start <token>` output into the private bot chat.
5. Create one clearly marked non-terminal synthetic order in WooCommerce admin,
   using no real payment or customer.
6. Run `docker compose exec backend npm run pilot:readiness`.
7. Begin V1 only after all nine readiness checks pass.

Do not sign a JWT, run SQL, construct API calls, install an unverified plugin,
expose PostgreSQL/Redis/internal services, or use a tunnel.

---

## 1. Safety Rules

- Use a dedicated test WooCommerce store or clearly marked test order.
- Do not use a real customer's active order or payment method.
- Never paste `.env`, JWTs, BotFather tokens, WooCommerce credentials, webhook
  secrets, internal API keys, callback tokens, or authorization headers into
  this file or an AI chat.
- Do not run SQL `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or `DROP`.
- Do not run `prisma migrate dev`, reset the database, or delete Docker volumes.
- Do not call `/api/internal/telegram/*` manually. Those routes require the bot
  service credential and are exercised through Telegram.
- Stop and record `BLOCKED` when a supported product path does not exist.

## 2. Repository-Derived Runtime Reference

### Docker Compose services

The repository defines exactly these services:

- `postgres`
- `redis`
- `backend`
- `telegram-bot`
- `caddy`

List and inspect them from the repository root:

```bash
docker compose config --services
docker compose ps
docker compose logs --tail=100 backend telegram-bot
```

Follow logs without changing state:

```bash
docker compose logs -f backend telegram-bot
```

Stop log following with `Ctrl+C`.

### Public health routes

```bash
curl --fail --silent --show-error http://localhost/api/health
curl --fail --silent --show-error http://localhost/api/health/readiness
```

Expected:

```json
{"status":"ok"}
{"status":"ready","dependencies":{"postgres":"up","redis":"up"}}
```

### Implemented Telegram commands

The bot implements these private-chat commands:

- `/start <link-token>` — redeem a backend-issued one-time link token
- `/start` — show current link status
- `/status` — show current link/authorization status
- `/unlink` — request confirmed unlink
- `/orders` — list projected orders

The bot rejects group, supergroup, and channel use. It has no `/link` or direct
`/order` command.

### Implemented backend routes relevant to setup

All routes below include the global `/api` prefix.

Public:

- `GET /api/health`
- `GET /api/health/readiness`
- `POST /api/plugin/register`
- `POST /api/webhooks/woocommerce/:endpointKey`

JWT-protected:

- `POST /api/tenants`
- `POST /api/stores`
- `GET /api/stores`
- `POST /api/stores/:id/test-connection`
- `POST /api/stores/:id/registration-token`
- `POST /api/stores/:id/webhook-credentials`
- `GET /api/stores/:id/connection-health`
- `POST /api/internal/telegram/link-tokens`

Bot-service-only:

- `POST /api/internal/telegram/redeem`
- `POST /api/internal/telegram/status`
- `POST /api/internal/telegram/unlink`
- `POST /api/internal/telegram/orders/list`
- `POST /api/internal/telegram/orders/detail`
- `POST /api/internal/telegram/orders/transitions`
- `POST /api/internal/telegram/orders/status`

### Prisma models and PostgreSQL tables

| Prisma model                | PostgreSQL table               |
| --------------------------- | ------------------------------ |
| `User`                      | `users`                        |
| `Tenant`                    | `tenants`                      |
| `Membership`                | `memberships`                  |
| `Store`                     | `stores`                       |
| `Order`                     | `orders`                       |
| `AuditLog`                  | `audit_logs`                   |
| `TelegramAccount`           | `telegram_accounts`            |
| `TelegramChatAuthorization` | `telegram_chat_authorizations` |
| `TelegramLinkToken`         | `telegram_link_tokens`         |
| `TelegramCallbackReference` | `telegram_callback_references` |
| `TelegramOrderStatusWrite`  | `telegram_order_status_writes` |

Use this read-only helper pattern:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "<READ-ONLY SQL>"'
```

---

# Part A — Readiness

## R0 — Runtime and Migration Readiness

Status: PASS

Recovery completed on 2026-07-24:

- stale backend image diagnosed and rebuilt;
- backend command corrected to `node dist/main.js`;
- local database and ignored `.env` backed up;
- all eight migrations applied with `prisma migrate deploy`;
- backend and bot recreated with synchronized local configuration;
- backend restart count remained `0`;
- PostgreSQL and Redis passed readiness;
- backend liveness and readiness passed;
- Telegram bot token was replaced privately and polling started;
- no application source code changed;
- no configured secret values were observed in logs.

Recheck:

```bash
docker compose ps
docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"'
curl --fail --silent --show-error http://localhost/api/health
curl --fail --silent --show-error http://localhost/api/health/readiness
docker compose logs --tail=50 telegram-bot
```

Pass criteria:

- all five services are `Up`;
- migration count is `8`;
- both HTTP checks succeed;
- bot logs contain `telegram_bot_polling_started`;
- no service is restarting.

Evidence:

- [ ] `docker compose ps`
- [ ] migration count
- [ ] health responses
- [ ] bot polling log

## R1 — M12-V Pilot Setup and Readiness Gate

Status: READY TO EXECUTE

M12-V is the supported unblocking step immediately preceding V1. It does not
use the connector stub and does not claim that the plugin implements onboarding
or webhook setup.

Configure:

```dotenv
PILOT_MODE=true
PILOT_WEBHOOK_BASE_URL=https://pilot-api.example.com
PILOT_READINESS_TIMEOUT_SECONDS=60
```

The webhook origin must be the approved VPS Caddy HTTPS origin. Caddy is the
only public entry point; PostgreSQL, Redis, the backend port, and other internal
services remain unexposed.

Run:

```bash
docker compose exec backend npm run pilot:setup
```

The command refuses non-pilot mode, non-public webhook origins, unrelated
existing User/Tenant bootstrap data, multiple Stores, and disabled or
disconnected Stores. It provides no force, reset, overwrite, delete, or teardown
option. WooCommerce REST credentials are entered without echo and are never
printed or written to a file.

Paste the one-time `/start <token>` output into the intended private Telegram
chat. Then create one clearly marked synthetic order in WooCommerce admin with
no real customer/payment and a non-terminal status.

Run:

```bash
docker compose exec backend npm run pilot:readiness
```

R1 passes only when all nine command checks pass:

- [ ] pilot User exists;
- [ ] Tenant exists;
- [ ] OWNER Membership exists;
- [ ] exactly one eligible `ACTIVE` Store exists;
- [ ] Store REST connection succeeds;
- [ ] all required order webhooks target the approved public HTTPS endpoint;
- [ ] Telegram is linked and authorized;
- [ ] the synthetic order is projected locally within the bounded wait;
- [ ] the synthetic order is visible to the Telegram order flow.

Attach the secret-free readiness output as R1 evidence. Do not add manual SQL,
JWT, curl, webhook, or Telegram-internal API evidence.

---

# Part B — Shortest Real-Store Path

Run this section only after R1 passes.

## S1 — Confirm linked context

In the bot's private chat:

```text
/status
```

Pass:

```text
Your Telegram account is linked and authorized.
```

Any “not linked,” “selection required,” or “no active store” message is
`BLOCKED`, not a V1 failure.

Read-only database evidence:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT
    ta.id AS telegram_account,
    tca.chat_type,
    tca.active_tenant_id,
    tca.active_store_id,
    tca.revoked_at
  FROM telegram_accounts ta
  JOIN telegram_chat_authorizations tca
    ON tca.telegram_account_id = ta.id
  WHERE ta.deleted_at IS NULL;
  "'
```

Do not record Telegram numeric user/chat IDs in this document.

## S2 — Confirm Store and role

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT
    s.id,
    s.name,
    s.status,
    s.plugin_registered_at IS NOT NULL AS plugin_registered,
    s.last_healthy_at,
    m.role
  FROM telegram_accounts ta
  JOIN memberships m
    ON m.user_id = ta.user_id AND m.deleted_at IS NULL
  JOIN stores s
    ON s.tenant_id = m.tenant_id AND s.deleted_at IS NULL
  WHERE ta.deleted_at IS NULL;
  "'
```

Pass:

- exactly one eligible Store;
- Store status `ACTIVE`;
- role `OWNER` or `ADMIN` for V1;
- Store health evidence is recent enough for the test.

## S3 — Create a synthetic WooCommerce order

Use the real store's WordPress admin interface:

1. Open **WooCommerce → Orders → Add order**.
2. Use a clearly synthetic identity such as `WCTM Validation`.
3. Use a controlled test email.
4. Do not use a real payment method.
5. Add a low-risk test product or a zero-value/manual test item.
6. Add the private note `M12 validation`.
7. Choose a non-terminal status supported by the store, usually `processing`
   or `pending`.
8. Save the order.

Record only:

- WooCommerce order ID:
- order number:
- initial status:
- creation time:

Do not record customer address, phone, email, or payment data.

## S4 — Confirm projection and Telegram visibility

Read-only projection check:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT
    o.wc_order_id,
    o.order_number,
    o.status,
    o.wc_modified_at,
    o.last_synced_at,
    o.remote_deleted_at
  FROM orders o
  ORDER BY o.created_at DESC
  LIMIT 10;
  "'
```

Then send:

```text
/orders
```

Pass:

- the synthetic order appears;
- its status matches WooCommerce;
- no real customer-sensitive data is required as evidence.

If the order never projects, stop with `BLOCKED — Store webhook/onboarding path
not operational`. Do not manually insert an `Order`.

---

# Part C — M12 Validation Cases

Classification:

- `MANUAL` — run through Telegram and the real test Store.
- `AUTOMATED EVIDENCE` — repository tests are the primary safe evidence.
- `CONTROLLED` — requires an approved fault-injection mechanism; do not improvise.

## V1 — OWNER/ADMIN successful status update

Type: MANUAL

Status: PENDING M12-V READINESS

Steps:

1. Record the synthetic order's current WooCommerce and projected statuses.
2. Send `/orders`.
3. Select the synthetic order.
4. Tap **Change status**.
5. Choose one offered status.
6. Save the Telegram result.
7. Reopen the order in WooCommerce and refresh.
8. Run the read-only checks below.

Order evidence:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT wc_order_id, order_number, status, wc_modified_at, last_synced_at
  FROM orders
  ORDER BY updated_at DESC
  LIMIT 5;
  "'
```

Write and audit evidence:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT
    w.wc_order_id,
    w.target_status,
    w.outcome,
    w.started_at,
    w.completed_at
  FROM telegram_order_status_writes w
  ORDER BY w.created_at DESC
  LIMIT 5;

  SELECT action, entity_type, entity_id, created_at
  FROM audit_logs
  WHERE action = '\''telegram.order.status.updated'\''
  ORDER BY created_at DESC
  LIMIT 5;
  "'
```

Pass:

- Telegram reports success;
- WooCommerce has the selected status;
- `orders.status` matches WooCommerce;
- exactly one completed status-write record exists;
- one `telegram.order.status.updated` audit row exists;
- logs contain no secrets.

Result:

- Status:
- Telegram:
- WooCommerce before/after:
- Database:
- Logs:
- Evidence:
- Notes:

## V2 — MEMBER denial

Type: MANUAL, requires a second supported MEMBER account

Status: BLOCKED until a MEMBER fixture/account exists

Steps:

1. Link a separate test SaaS User whose active Membership role is `MEMBER`.
2. Send `/orders` and open the synthetic order.
3. Confirm no **Change status** button is rendered.

Pass:

- read-only order detail is available;
- no status-write action is offered;
- no row is added to `telegram_order_status_writes`;
- no WooCommerce write occurs.

Do not change an OWNER role directly in SQL for this test.

Result:

- Status:
- Evidence:
- Notes:

## V3 — Invalid or expired callback

Type: MANUAL for expiry; automated evidence for tampering

Status: PENDING M12-V READINESS

Safe manual path:

1. Open an order and the status menu.
2. Wait longer than the configured callback-reference TTL.
3. Tap a status button from the old message.

Inspect the non-secret TTL setting:

```bash
docker compose exec -T backend printenv TELEGRAM_CALLBACK_REF_TTL_SECONDS
```

Pass:

- Telegram reports expiry/context change;
- no WooCommerce write occurs;
- no successful status-write or audit row is created.

Do not tamper with callback bytes manually. Signature tampering is covered by
the automated M12 tests.

Result:

- Status:
- Evidence:
- Notes:

## V4 — Duplicate callback

Type: AUTOMATED EVIDENCE; manual only if Telegram preserves the same button

Status: PENDING M12-V READINESS

Repository safety boundary:

- `telegram_order_status_writes` has a unique constraint on
  `(callback_reference_id, target_status)`.
- M12 tests cover idempotent replay.

If the same Telegram button remains available, tap it twice. Do not manufacture
an internal API request or expose the bot API key.

Database proof:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT callback_reference_id, target_status, count(*)
  FROM telegram_order_status_writes
  GROUP BY callback_reference_id, target_status
  HAVING count(*) > 1;
  "'
```

Pass: zero rows.

Result:

- Status:
- Automated test evidence:
- Manual evidence, if available:
- Notes:

## V5 — Delayed callback

Type: MANUAL

Status: PENDING M12-V READINESS

Use the same safe procedure as V3, once inside the TTL and once after expiry.

Pass:

- inside TTL: at most one legitimate write;
- after expiry: no write;
- no duplicate status-write rows.

Result:

- Status:
- Evidence:
- Notes:

## V6 — Active context changed before callback

Type: BLOCKED PRODUCT CAPABILITY

M10 deliberately excluded tenant/Store selection and switching. There is no
supported operator flow to change active context for this test.

Do not edit `telegram_chat_authorizations` manually. Keep this case `BLOCKED`
until a supported context-selection/switching flow or an approved test fixture
exists. Existing integration tests remain the only safe evidence.

Result:

- Status: BLOCKED
- Automated test evidence:
- Notes:

## V7 — WooCommerce unreachable before confirmation

Type: CONTROLLED

Status: BLOCKED — no approved fault-injection control

Do not disable the real Store, alter DNS, revoke credentials, or block system
networking ad hoc.

This case may run only after a repository-supported fault injection, test proxy,
or dedicated disposable WooCommerce environment is approved. Until then, use
M6/M12 automated timeout and retry tests as evidence.

Result:

- Status: BLOCKED
- Automated test evidence:
- Notes:

## V8 — Ambiguous timeout after dispatch

Type: CONTROLLED

Status: BLOCKED — no approved response-loss injection control

This requires allowing WooCommerce to commit the write while dropping only the
response. The repository has no operator-facing fault-injection mechanism for
this condition.

Do not simulate it by killing random containers or changing production network
rules. Use the automated lost-response reconciliation tests until a safe proxy
or fixture is implemented.

Result:

- Status: BLOCKED
- Automated test evidence:
- Notes:

## V9 — Authoritative reconciliation

Type: MANUAL, observed as part of V1

Status: PENDING M12-V READINESS

After V1:

1. Compare the selected target with WooCommerce.
2. Compare WooCommerce with `orders.status`.
3. Confirm `orders.last_synced_at` advanced.
4. Confirm Telegram detail shows the reconciled status.

Pass: all three sources agree.

Result:

- Status:
- Evidence:
- Notes:

## V10 — Local Order projection update

Type: MANUAL, observed as part of V1

Status: PENDING M12-V READINESS

Use the V1 Order query. Pass when the projected Order matches WooCommerce and
has a new `last_synced_at`.

Result:

- Status:
- Evidence:
- Notes:

## V11 — Telegram message-edit failure fallback

Type: AUTOMATED EVIDENCE

Status: MANUAL REPRODUCTION NOT REQUIRED

The bot test suite explicitly forces `editMessageText` failure and verifies
fallback to a new message.

Run:

```bash
npm run build --workspace=@wc-telegram/telegram-bot
npm run test --workspace=@wc-telegram/telegram-bot
```

Pass: Telegram bot tests pass, including M12 edit-failure fallback.

Result:

- Status:
- Test output:
- Notes:

## V12 — Bot/backend restart safety

Type: MANUAL, safe after V1 passes

Status: PENDING M12-V READINESS

Procedure:

1. Open the synthetic order's status menu but do not choose a target.
2. Restart only the bot and backend:

   ```bash
   docker compose restart telegram-bot backend
   docker compose ps backend telegram-bot
   curl --fail --silent --show-error http://localhost/api/health/readiness
   ```

3. Wait until bot logs show `telegram_bot_polling_started`.
4. Tap the previously issued status button if it is still within TTL.

Pass:

- callback reference survives restart;
- at most one WooCommerce write occurs;
- backend and bot remain healthy;
- database uniqueness query from V4 returns zero rows.

Result:

- Status:
- Evidence:
- Notes:

## V13 — Audit and secret-leak review

Type: MANUAL REVIEW

Status: AVAILABLE AFTER V1

Capture logs to a temporary ignored location outside the repository:

```bash
docker compose logs --no-color backend telegram-bot > /tmp/wctm-m12-logs.txt
```

Search only for sensitive field names or header names, not secret values:

```bash
rg -n -i \
  'authorization|x-bot-api-key|consumer[_-]?secret|consumer[_-]?key|jwt[_-]?secret|encryption[_-]?key|telegram[_-]?bot[_-]?token|webhook[_-]?secret|plugin[_-]?secret' \
  /tmp/wctm-m12-logs.txt
```

Review matches manually. A field name in a safe redaction message is not a leak;
an actual credential/token value is a `FAIL` and must not be pasted into chat.

Read audit metadata safely:

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT action, entity_type, entity_id, metadata, created_at
  FROM audit_logs
  WHERE action = '\''telegram.order.status.updated'\''
  ORDER BY created_at DESC
  LIMIT 10;
  "'
```

Pass:

- no secrets, credentials, raw authorization headers, or callback tokens appear;
- audit metadata contains only bounded operational fields.

Delete the temporary log copy after review:

```bash
rm -- /tmp/wctm-m12-logs.txt
```

Result:

- Status:
- Matches reviewed:
- Evidence:
- Notes:

## V14 — No duplicate WooCommerce writes

Type: MANUAL DATABASE AUDIT + AUTOMATED EVIDENCE

Status: AVAILABLE AFTER V1/V4/V5/V12

```bash
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
  SELECT callback_reference_id, target_status, count(*) AS rows
  FROM telegram_order_status_writes
  GROUP BY callback_reference_id, target_status
  ORDER BY rows DESC;
  "'
```

Pass:

- every `(callback_reference_id, target_status)` has exactly one row;
- WooCommerce access evidence shows at most one write per legitimate action;
- duplicate callbacks return the persisted result.

Result:

- Status:
- Evidence:
- Notes:

---

# Part D — Validation Summary

## Required real-store evidence

The shortest meaningful real-store acceptance path is:

1. R0 runtime readiness;
2. R1 supported onboarding and data readiness;
3. S1–S4 linked Store/order readiness;
4. V1 successful write;
5. V9 authoritative reconciliation;
6. V10 local projection update;
7. V13 secret-safe audit/log review;
8. V14 duplicate-write database audit.

V2 requires a supported MEMBER account. V3/V5/V12 are safe secondary manual
checks. V4/V11 have strong automated evidence. V6–V8 remain blocked until the
missing product/test capabilities are implemented.

## Overall result

- Runtime readiness: PASS
- M12-V private-pilot readiness: PENDING OPERATOR EXECUTION
- Real-store M12 validation: NOT STARTED
- Confirmed defects:
- Product/test blockers:
  - V6: no supported active-context switching flow
  - V7/V8: no approved fault-injection mechanism
- Phase 4 closure recommendation: DO NOT CLOSE

## Defect template

### DEFECT-###

- Severity:
- Related case:
- Expected:
- Actual:
- Reproduction:
- Secret-safe evidence:
- Scope recommendation:

## Validation handoff

Send B and A only this concise finding after running M12-V:

> M12-V pilot setup/readiness: PASS or FAIL. No manual SQL, JWT signing, secret
> copying, plugin claim, or tunnel was used. If PASS, V1 may begin. If FAIL,
> include only the command's single actionable failure and secret-free evidence.
