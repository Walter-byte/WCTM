# Project Handoff Document

**Generated:** 2026-07-19

**Updated:** 2026-07-23

**Reason:** Transitioning implementation agent from GapCode to Codex GPT

**Project:** WC-Telegram-SaaS

**Prepared by:** Walter (Salar / walterbyte)

---

## 1. Project Overview

A production SaaS platform that allows WooCommerce store owners to manage their
stores entirely through Telegram. Telegram is the **primary management interface**,
not just an alert channel.

**Target market (initial):** Iran
**Architecture pattern:** Multi-tenant SaaS, simplicity-first (D-010)

---

## 2. Technology Stack

| Layer                         | Technology                                               |
| ----------------------------- | -------------------------------------------------------- |
| Backend API                   | NestJS (Fastify adapter considered, Express default)     |
| Database                      | PostgreSQL                                               |
| ORM / Migrations              | Prisma 7 (Prisma Migrate)                                |
| Queue / Jobs                  | BullMQ                                                   |
| Cache / Sessions / Rate-limit | Redis                                                    |
| Telegram Bot                  | grammY                                                   |
| WooCommerce                   | REST API + Webhooks                                      |
| WordPress Plugin              | Lightweight connector (auth, registration, webhook mgmt) |
| Containerization              | Docker / Docker Compose                                  |
| Reverse Proxy                 | Caddy                                                    |
| Language                      | TypeScript (strict)                                      |

n8n is **NOT** part of the production architecture (D-008, prototype only).

---

## 3. Architectural Decisions (D-001–D-021)

| ID    | Decision                                                                                                                                                                                            | Status   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D-001 | Develop as production SaaS                                                                                                                                                                          | Accepted |
| D-002 | NestJS for backend (alt: Fastify standalone)                                                                                                                                                        | Accepted |
| D-003 | PostgreSQL as database                                                                                                                                                                              | Accepted |
| D-004 | Redis mandatory (cache, queues, sessions, rate-limiting)                                                                                                                                            | Accepted |
| D-005 | BullMQ for async jobs                                                                                                                                                                               | Accepted |
| D-006 | WooCommerce via REST API + Webhooks                                                                                                                                                                 | Accepted |
| D-007 | Telegram is primary management UI                                                                                                                                                                   | Accepted |
| D-008 | n8n excluded from production                                                                                                                                                                        | Accepted |
| D-009 | WordPress plugin stays lightweight                                                                                                                                                                  | Accepted |
| D-010 | Simplicity-first; no overengineering, no premature optimization                                                                                                                                     | Accepted |
| D-011 | Prisma ORM + Prisma Migrate; `schema.prisma` is single source of truth; all models have `created_at`/`updated_at`; soft-delete on Tenant, Store, Membership                                         | Accepted |
| D-012 | PrismaService uses Prisma's official PostgreSQL driver adapter                                                                                                                                      | Accepted |
| D-013 | Global typed configuration uses `@nestjs/config` with Joi validation                                                                                                                                | Accepted |
| D-014 | One in-process BullMQ operations worker with three exponential-backoff attempts                                                                                                                     | Accepted |
| D-015 | Fail-closed WooCommerce credential validation with bounded REST retries, timeouts, and secret-safe normalized errors                                                                                | Accepted |
| D-016 | WooCommerce-REST-only plugin registration verification, reissue-and-rotate recovery, and endpoint-scoped Redis limiting                                                                             | Accepted |
| D-017 | Dedicated encrypted webhook secrets, routing-only endpoint keys, raw-body HMAC authentication, recoverable idempotent persist/enqueue, and OWNER/ADMIN rotation                                     | Accepted |
| D-018 | Store-scoped Order projection with timestamp/fingerprint ordering, processing-lease recovery, bounded single-order reconciliation, and verified delete/restore handling                             | Accepted |
| D-019 | Backend-owned one-time Telegram linking, bot-key internal API, private-chat-only authorization, update idempotency, exact-one context resolution, and soft unlinking                                | Accepted |
| D-020 | Read-only M9 Order access with bounded keyset pagination, `lastSyncedAt` freshness, and expiring HMAC-authenticated callback references bound to current Telegram context                           | Accepted |
| D-021 | OWNER/ADMIN Telegram order-status writes using server-derived targets, single-effect HMAC references, durable idempotency, one WooCommerce dispatch, and authoritative/lost-response reconciliation | Accepted |

Next decision number: **D-022**, if a future task produces a genuine
architectural or product decision.

---

## 4. Completed Tasks

### Phase 0 — Foundation (100% complete)

- Product idea validated
- SaaS vision defined
- Technology stack selected
- Production architecture designed
- Core documentation created (`PROJECT-TELEGRAM-WC-SAAS.md`, `MASTER-ROADMAP.md`,
  `PROJECT_STATE.md`, `DECISIONS.md`, `AI_OPERATING_MANUAL.md`)
- AI workflow established

### Phase 1 — Project Initialization (Tasks 1.1–1.4 complete)

#### Task 1.1 — Repository & Docker Scaffold

- Monorepo structure initialized
- `docker-compose.yml` created with backend, PostgreSQL, Redis, Telegram bot,
  and Caddy services
- Multi-stage `Dockerfile` created for the backend
- Container `WORKDIR` set to `/app/backend`
- Environment template (`.env.example`) created
- Compose network names are project-scoped to prevent cross-project collisions
- Application encryption configuration uses `APP_ENCRYPTION_KEY`
- Base `package.json` for the backend workspace

#### Task 1.2 — Prisma Integration & Core Schema

**Prisma schema location:** `backend/prisma/schema.prisma`

**Models (6 total):**

- `Tenant` — organization/account; has `plan` (TenantPlan enum), soft-delete (`deleted_at`)
- `User` — global user model; linked to tenants via Membership
- `Membership` — links User↔ Tenant with `MembershipRole`; soft-delete
- `Store` — WooCommerce store owned by a Tenant; has `status` (StoreStatus enum),
  encrypted credential fields (`consumer_key_encrypted`, `consumer_secret_encrypted`,
  `webhook_secret_encrypted`), soft-delete
- `WebhookEvent` — inbound events with `dedupe_key` for idempotency
- `AuditLog` — audit records; structural immutability is not yet enforced because
  the model includes an updatable timestamp. This is a known limitation and a
  candidate decision for A, not a Task 1.4 schema change.

**Enums (3 total):**

- `TenantPlan`: future billing tiers (no billing logic yet)
- `StoreStatus`: store health/connection state
- `MembershipRole`: minimal tenant roles (`OWNER`, `ADMIN`, `MEMBER`)

**Schema conventions enforced:**

- `snake_case` table/column names via `@map` / `@@map`
- Prefixed string IDs
- `created_at` / `updated_at` on every model
- Soft-delete (`deleted_at`) on Tenant, Store, Membership
- Every foreign key is indexed by default
- Credentials stored as separate encrypted fields (not a generic blob)

**Migration:** `init_schema` migration generated, deployed in the clean-clone
environment, and verified in sync.
**Commands verified:** `prisma validate`✓ | `prisma format --check` ✓ | `prisma generate` ✓

**`backend/package.json`** includes:

```json
"prisma": {
  "schema": "prisma/schema.prisma"
}
```

**Important:** `DATABASE_URL` points to `postgres:5432` (Docker Compose service name),
only resolvable inside the Docker network. Run migrations via:

```bash
docker compose exec backend npx --no-install prisma migrate deploy
```

The production backend image currently omits the Prisma CLI because Prisma is a
development dependency excluded by its production install. M3 migration
verification used the Docker builder stage inside the Compose network. The
runtime migration execution path requires a future approved infrastructure fix.

#### Task 1.3 — NestJS Prisma Module Integration

**Files created/modified:**

- `backend/src/prisma/prisma.module.ts` — `@Global()` module, exports `PrismaService`
- `backend/src/prisma/prisma.service.ts` — extends `PrismaClient`, implements
  `OnModuleInit` (`$connect()`) and `OnModuleDestroy` (`$disconnect()`)
- `backend/src/main.ts` — `app.enableShutdownHooks()` added for graceful SIGTERM

**Behavior:**

- PrismaService connects on application startup
- PrismaService disconnects cleanly on SIGTERM
- Any NestJS module can inject `PrismaService` without re-importing `PrismaModule`
- No repositories, domain services, or extra abstractions added

**Quality gates passed:**

- TypeScript typecheck ✓
- ESLint ✓
- Prettier ✓
- Build✓
- `prisma generate` ✓
- `prisma validate` ✓

#### Task 1.4 — Clean-Environment Verification and Phase 1 Closure

- A clean clone installed dependencies and built successfully
- PostgreSQL and Redis health checks passed
- `init_schema` deployed and Prisma reported the database in sync
- Backend health and Caddy root endpoints passed
- Telegram bot offline scaffold started safely
- Graceful shutdown and full `docker compose down -v` teardown passed
- Fixed Compose network isolation and standardized `APP_ENCRYPTION_KEY`
- Added one offline NestJS boot smoke test and a basic Node 20 CI workflow
- Generated repository trees are intentionally excluded via `.gitignore`

### Phase 2 — Backend Core (complete)

#### Task 2.1 — Configuration Foundation (complete)

- `backend/src/config/application-config.module.ts` provides global validated
  configuration
- Application consumers inject `ApplicationConfigService` and use typed
  namespaces instead of reading `process.env`
- Namespaces cover application settings, PostgreSQL, Redis, JWT, application
  encryption, Telegram, and WooCommerce webhook settings
- Joi validation aggregates all failures before throwing a secret-safe startup
  error
- Test mode supplies isolated placeholders; production requires all application
  values and rejects documented development placeholders
- Configuration and secret namespaces mask sensitive values during JSON/string
  serialization and Node inspection
- Task 2.1 was merged into `main` in commit `19cb0d3`, containing implementation
  commit `2a39455`

#### Task 2.2 — Authentication Foundation (complete)

- The existing JWT configuration namespace now exposes the required
  `JWT_ACCESS_TTL` value as `accessTokenTtl`
- `AuthService` signs and verifies access tokens using only typed JWT settings
- Passport validates bearer tokens through `JwtStrategy`
- `JwtAuthGuard` protects routes globally; handlers or controllers must use
  `@Public()` for an explicit unauthenticated opt-out
- `@CurrentUser()` exposes the validated JWT payload to route handlers
- The health endpoint is public so container and operator health checks continue
  to work
- This foundation intentionally excludes user persistence, credential login,
  refresh tokens, RBAC, and tenant authorization
- Task 2.2 was merged into `main` in commit `9a9bbd4`

#### M1 — Database & Application Foundation (complete)

- `backend/src/common/logging/` provides the global structured JSON logger and
  request logging interceptor; `LOG_LEVEL` comes from
  `ApplicationConfigService`
- `backend/src/common/request-context/` uses AsyncLocalStorage to preserve an
  inbound `x-request-id` or generate a UUID, echo it on the response, and attach
  it to request logs
- `backend/src/common/filters/` normalizes HTTP and unknown exceptions as
  `{ statusCode, error, message, requestId }` without exposing unknown internals
- `backend/src/common/utils/` is reserved for shared utilities used by common
  infrastructure; M1 adds only secret-safe redaction and serialization support
- Jest covers the new common infrastructure while the existing Node smoke,
  configuration, and authentication tests remain part of the full suite
- M1 introduces no schema, tenant, RBAC, user, WooCommerce, audit, or job logic
- M1 was merged into `main` in commit `2dcade7`

#### M2 — Multi-Tenant Core (complete)

- `TenantContextService` exposes the active authenticated `tenantId`, `userId`,
  and membership role and fails closed when tenant context is unavailable
- Tenant data extends M1's existing request AsyncLocalStorage context; M2 does
  not introduce a second request-lifecycle store
- The global `TenantContextGuard` runs after JWT authentication, resolves an
  active Membership using signed `sub` and `tenantId` claims, and rejects absent
  or unauthorized membership with 403
- Explicit `@Public()` routes bypass tenant resolution; `@RequireMembership()`
  optionally restricts a route to listed membership roles without introducing
  an RBAC permission matrix
- `TenantScopedPrismaService` demonstrates tenant-owned Store reads and writes;
  it sources `tenantId` only from TenantContext and injects it into every query
- Isolation tests prove Tenant A cannot read or mutate Tenant B's Store row
- M2 adds no schema migration, tenant CRUD, user management, store endpoint,
  integration, billing, or job logic
- M2 was merged into `main` in commit `80ac3ee`

#### M3 — User & Tenant Management (complete)

- `UsersModule` exposes JWT-protected, tenant-optional own-profile read and
  display-name update endpoints backed by persisted User records
- `TenantsModule` creates a tenant and its creator's OWNER membership atomically;
  current-tenant read, name update, and soft deletion use server tenant context
- `MembershipsModule` adds existing users, lists active memberships, changes
  roles, and soft-deletes memberships within the active tenant only
- `MembershipRole` replaces the free-form role string with `OWNER`, `ADMIN`, and
  `MEMBER`; migration `20260721160000_membership_role_enum` is applied and in
  sync in the local verification database
- OWNER and ADMIN may manage non-owner memberships; only OWNER may grant or
  manage OWNER, and the final active OWNER cannot be removed or demoted
- `@TenantOptional()` bypasses tenant resolution only for JWT-authenticated own
  profile and tenant-bootstrap routes; it does not bypass authentication
- Joi request pipes validate DTOs without adding dependencies, and tests cover
  lifecycle behavior, role enforcement, cross-tenant denial, and soft deletes
- M3 adds no authentication flow, advanced RBAC, store CRUD, integration,
  billing, background-job, or audit tooling
- M3 was merged into `main` in commit `c042b5b`

#### M4 — WooCommerce Store Management (complete)

- `EncryptionModule` exports `EncryptionService`, whose `encrypt()` and
  `decrypt()` methods use AES-256-GCM with the typed
  `ApplicationConfigService.encryption.key`; stored values use base64
  `iv:authTag:ciphertext` components
- `WooCommerceClient` is instantiated per connection test with decrypted
  in-memory credentials and exposes
  `testConnection(): Promise<{ success, storeName?, error? }>`
- `StoreModule` registers tenant-scoped `/stores` create, list, read, update,
  soft-delete, and `/:id/test-connection` routes
- `TenantScopedPrismaService` injects the active server-side tenant into every
  Store query; missing, deleted, and cross-tenant records return 404 without
  confirming ownership
- Store API responses use credential-free Prisma selections. Raw and encrypted
  consumer credentials are never returned or logged; decrypted values exist
  only while constructing the per-request WooCommerce client
- OWNER and ADMIN memberships may create, update, and delete stores; MEMBER may
  read stores and run a connection test
- M4 adds only the required direct `axios` runtime dependency for the approved
  WooCommerce REST client; the existing Store schema requires no migration
- Eleven focused M4 tests cover encryption, CRUD, soft deletion, connection
  results, cross-tenant isolation, and MEMBER mutation denial
- M4 was merged into `main` in commit `2da985b`

#### M5 — Production Operations Foundation (complete)

- `AuditModule` exports `AuditService.record()` for action, entity, entity ID,
  and metadata input; tenant and actor IDs come only from `TenantContextService`
- Membership create/reactivate, role update, and removal plus Store create,
  update, soft-delete, and connection tests emit append-only AuditLog records
- Audit metadata accepts only approved roles, Store statuses, safe changed-field
  names, credential-change booleans, and connection success; raw secrets,
  tokens, passwords, keys, URLs, and payloads are not persisted
- `QueueModule` owns one BullMQ `operations` queue, one reference producer, and
  one in-process worker using exact-pinned BullMQ `5.80.10`
- Producers source tenant identity from server context. Processors reject
  missing or malformed `tenantId` and validate optional `storeId`
- Reference jobs use three total attempts with exponential backoff starting at
  one second. Exhausted jobs remain failed in BullMQ and emit a structured error
  without logging exception text or payload contents
- `GET /api/health` remains the public liveness endpoint;
  `GET /api/health/readiness` returns 200 only when PostgreSQL and Redis respond
- Nest shutdown hooks wait for active worker work, then close worker and queue
  connections on SIGTERM/SIGINT
- The existing AuditLog and Store schemas were sufficient; M5 has no migration
- M5 was merged into `main` in commit `0cdf0e6`

Operational runbook:

1. Start the backend with PostgreSQL and Redis available; the operations worker
   starts inside the backend process outside `NODE_ENV=test`.
2. Probe `/api/health` for process liveness and `/api/health/readiness` before
   routing traffic. A readiness 503 means PostgreSQL or Redis is unavailable.
3. Inspect structured backend logs for
   `Background job exhausted retry attempts`; use the logged queue, job ID,
   tenant ID, optional Store ID, and attempt count for diagnosis. Secrets and
   raw errors are intentionally absent.
4. Send SIGTERM/SIGINT or use `docker compose stop backend` for graceful worker
   and queue connection shutdown. Do not force-kill during active work unless
   recovery procedures require it.

### Phase 3 — WooCommerce Integration (complete)

#### M6 — REST Client Hardening & Credential Validation (complete)

- `WooCommerceClient` uses configuration-backed limits: three total attempts,
  5,000ms per-attempt timeouts, and a 15,000ms hard operation cap
- Retry delays use a 300ms exponential base, factor two, and ±20% jitter; only
  transport failures, timeouts, HTTP 429, and HTTP 5xx are retried
- Errors normalize to `auth`, `not-found`, `transport`, `rate-limited`,
  `timeout`, or `unexpected` without retaining credentials, tokens, full
  authorization headers, or raw Axios/WooCommerce failure details
- Store creation validates live reachability and authentication before
  persistence
- Credential-changing updates validate the proposed credential set before any
  Store mutation; failed validation preserves all existing Store fields
- The existing `/:id/test-connection` result shape remains unchanged
- M6 adds no dependency, schema migration, webhook, plugin registration,
  WooCommerce resource endpoint, or synchronization behavior
- M6 was merged into `main` in commit `288caf9`

#### M7 — Plugin Communication & Store Registration (MVP) (complete)

Schema and migration:

- Migration: `20260722142357_store_registration_handshake`
- `StoreStatus` literals remain `PENDING`, `ACTIVE`, `DISCONNECTED`, and
  `DISABLED`
- Store fields: nullable `registration_token_hash`,
  `registration_token_expires_at`, `registration_token_consumed_at`,
  `plugin_secret_hash`, `plugin_registered_at`, `last_seen_at`, and
  `last_healthy_at`
- Registration-token hashes are unique when non-null; WooCommerce credential
  fields are unchanged

Endpoints:

- `POST /api/stores/:storeId/registration-token` — OWNER/ADMIN; requires an
  existing active-tenant Store; returns `{ token, expiresAt }` once
- `POST /api/plugin/register` — public behind Caddy HTTPS; accepts only
  `{ token }`; returns `{ pluginCredential, storeId }` once after atomic success
- `GET /api/stores/:storeId/connection-health` — OWNER/ADMIN/MEMBER; returns
  `{ status, lastSeenAt, lastHealthyAt, registered }`

Credential and verification boundaries:

- WooCommerce REST credentials remain encrypted and are used only for
  SaaS→WooCommerce calls and M6 verification
- Registration tokens are one-time handshake values, stored only as SHA-256
  hashes with a 15-minute TTL
- Persistent plugin credentials authenticate plugin→SaaS only; plaintext is
  returned once and only its SHA-256 hash is stored
- Registration verification is the M6 WooCommerce REST connection test. M7 has
  no SaaS→plugin probe, plugin endpoint URL, or plugin-channel verification
- Lost-response recovery is OWNER/ADMIN token reissue followed by successful
  credential replacement; consumed-token replay returns no credential and does
  not rotate
- Public registration alone uses a configurable Redis fixed-window limiter

Atomic success consumes the token, stores the plugin credential hash, records
registration/health timestamps and audit state, and changes the Store from
`PENDING` to `ACTIVE`. Auth or transient failures preserve all credentials,
token state, Store status, and health timestamps. Concurrent duplicate
finalization commits exactly one credential.

#### M8 — WooCommerce Webhook Verification & Idempotent Ingestion (complete)

Store webhook credentials:

- `Store.webhook_endpoint_key` is a nullable, unique, indexed, URL-safe opaque
  routing value. It is not an authentication mechanism.
- The dedicated webhook secret remains in `webhook_secret_encrypted` using the
  existing AES-256-GCM `iv:authTag:ciphertext` representation and is never the
  `plugin_secret_hash`.
- Existing M7 registration finalization generates both values atomically when
  absent and returns them to the plugin only in that successful response.
- `POST /api/stores/:id/webhook-credentials` is tenant-scoped and restricted to
  OWNER/ADMIN. It provisions missing values or rotates both when `{ "rotate":
true }` is supplied. A generated secret is returned once; an existing secret
  is never re-exposed. Rotation invalidates the prior secret and endpoint key
  immediately.

Ingress contract:

- `POST /api/webhooks/woocommerce/:endpointKey` is explicitly public because
  WooCommerce cannot present a SaaS JWT. Security is HMAC verification; the
  endpoint key provides routing only.
- The route resolves an `ACTIVE`, non-deleted Store and active tenant before
  validating `X-WC-Webhook-Signature`, `X-WC-Webhook-ID`,
  `X-WC-Webhook-Delivery-ID`, and `X-WC-Webhook-Topic`.
- Only this route receives an Express raw `Buffer`. HMAC-SHA256 is verified over
  those exact bytes with a length-guarded `timingSafeEqual`; JSON parsing occurs
  only after authentication. The normal global JSON and URL-encoded parsers
  remain enabled for all other routes.
- Unknown endpoint keys return one generic 404 without tenant or Store detail.
  Invalid signatures return 401 and malformed authenticated envelopes return 400.

Persistence and queue lifecycle:

- `WebhookEvent` stores the immutable server-derived tenant/Store identity,
  WooCommerce webhook ID, delivery ID, topic, dedupe key, JSON payload, and
  receipt time.
- The existing unique `(store_id, dedupe_key)` constraint represents
  `{storeId, deliveryId}`. Lifecycle values are `RECEIVED`, `QUEUED`,
  `PROCESSING`, `COMPLETED`, and terminal `FAILED`.
- Ingestion first persists `RECEIVED`, then enqueues
  `woocommerce.webhook.process` on the M5 `operations` queue with a
  deterministic job ID derived from the WebhookEvent ID, then marks `QUEUED`.
- If enqueueing fails, the row remains `RECEIVED` and ingress returns 5xx.
  Redelivery retries the same deterministic publication. Duplicate events in
  any later lifecycle state return 200 without another row or job.
- The worker reuses M5's three exponential-backoff attempts and advances
  lifecycle state only. Exhaustion records `FAILED` and emits secret-safe
  correlation-aware structured logs. M8 adds no domain synchronization and no
  readiness or metrics surface.

Migration: `20260723120000_woocommerce_webhook_ingestion`.

#### M9 — Order Webhook Projection & Single-Order Reconciliation (complete)

- Migration `20260723180000_order_projection` adds the Order snapshot and unique
  `(store_id, wc_order_id)` identity boundary plus WebhookEvent lease, attempt,
  and bounded diagnostic fields
- `order.created` and `order.updated` project totals, customer display data,
  line items, WooCommerce timestamps, and a canonical SHA-256 fingerprint
- Older timestamps and exact equal-timestamp duplicates are no-ops; newer
  snapshots apply; equal-timestamp content conflicts fetch exactly one
  authoritative order through the bounded M6 client
- Missing/unreliable timestamps and malformed payloads with a stable order ID
  use the same single-order reconciliation path
- The operations worker derives tenant and Store only from the persisted
  WebhookEvent Store relation and ignores payload/queued ownership claims
- A 30-second processing lease permits crash recovery while blocking active
  duplicate work; Store-scoped uniqueness remains the final safety boundary
- Retryable transport, timeout, and rate-limit failures return to `QUEUED` for
  the existing three attempts. Auth, not-found, malformed, unexpected terminal,
  and exhausted failures persist secret-safe `FAILED` diagnostics
- WooCommerce core source confirms `order.deleted` delivers `{ id }` and
  `order.restored` delivers the REST resource. M9 retains snapshots on delete
  and re-projects them on restore
- No Telegram behavior, outbound WooCommerce write, related domain model, bulk
  sync, polling, historical import, replay surface, or metrics platform is added

### Phase 4 — Telegram Platform (active)

#### M10 — Telegram Account Linking & Private-Chat Authorization (complete)

- `POST /api/internal/telegram/link-tokens` uses the authenticated JWT user
  subject and returns a short-lived raw link token once; only its SHA-256 hash
  is stored.
- Bot-only `redeem`, `status`, and `unlink` internal endpoints require
  `X-Bot-Api-Key` and propagate `X-Correlation-Id` plus
  `X-Telegram-Update-Id`.
- TelegramAccount enforces unique Telegram-user and SaaS-user identities.
  TelegramChatAuthorization authorizes unique private chats only and always
  joins through TelegramAccount.
- Migration `20260723220000_telegram_account_linking` applied cleanly in an
  isolated PostgreSQL database.
- Redemption and confirmed unlink are atomic and update-idempotent. Unlink
  soft-revokes the account and every related chat authorization.
- Active tenant and Store context is persisted only when exactly one active
  Membership and exactly one non-deleted `ACTIVE` Store are eligible.
- The grammY process now long-polls and implements `/start`,
  `/start <token>`, `/status`, and confirmed `/unlink`. It has no Prisma import,
  database connection, or local persisted state.
- Groups, supergroups, and channels receive a safe rejection. Order management,
  Store switching, and webhook transport remain excluded.

#### M11 — Telegram Order Listing & Detail (read-only) (complete)

Internal endpoint contracts:

- `POST /api/internal/telegram/orders/list` accepts
  `{ telegram: { userId, chatId }, cursor? }` and returns typed `OK`,
  `NO_ACTIVE_STORE`, `UNAUTHORIZED`, or `CONTEXT_CHANGED` state, sanitized
  Order summaries, previous/next cursors, and freshness.
- `POST /api/internal/telegram/orders/detail` accepts
  `{ telegram: { userId, chatId }, ref }` and returns typed `OK`, `NOT_FOUND`,
  `DELETED`, `CONTEXT_CHANGED`, `NO_ACTIVE_STORE`, or `UNAUTHORIZED` state,
  sanitized detail or a minimal deletion marker, back cursor, and freshness.
- Both routes require `X-Bot-Api-Key` and a valid
  `X-Telegram-Update-Id`; correlation IDs continue through
  `X-Correlation-Id`.

Authorization matrix:

| Membership state                                           | OWNER            | ADMIN            | MEMBER           |
| ---------------------------------------------------------- | ---------------- | ---------------- | ---------------- |
| Active membership, active tenant, exactly one ACTIVE Store | Read             | Read             | Read             |
| Soft-deleted/inactive membership or tenant                 | Deny             | Deny             | Deny             |
| Zero/multiple active Stores or multiple active memberships | Context required | Context required | Context required |

Pagination and callback references:

- Pages are fixed at eight rows and ordered by
  `wc_created_at DESC, wc_order_id DESC`; full-boundary keyset predicates avoid
  offset skips/duplicates.
- Previous/next traversal stops at a 200-row reachable window.
- Telegram callback data is a 35-character purpose-prefixed random reference
  plus truncated HMAC-SHA256 tag, never a raw tenant, Store, or order ID.
- Migration `20260723230000_telegram_order_callback_references` persists the
  short-lived binding to Telegram account/chat, tenant, Store, purpose,
  boundary/order key, issuance time, and expiry. The complete migration chain
  applied cleanly in an isolated PostgreSQL database and Prisma status reported
  it up to date.
- Signature, TTL, purpose, and live context binding are validated on every use;
  stale keyboards return `CONTEXT_CHANGED`.
- Freshness derives from `Order.lastSyncedAt`; an empty set is delayed and never
  presented as a fresh sync.

Bot transport:

- `/orders` renders backend-provided summaries and inline previous/next/detail
  actions; detail views include a back action.
- Groups are rejected before backend access, duplicate update IDs are ignored,
  backend requests use a configured timeout, malformed responses are safely
  logged by correlation ID, and edit failures fall back to a new message.
- The bot has no Prisma import, database connection, WooCommerce call, filtering,
  ownership parsing, or domain mutation.

#### M12 — Telegram Order Status Update (implemented; in review)

- `POST /api/internal/telegram/orders/transitions` accepts an M11 detail
  reference, revalidates current context and OWNER/ADMIN role, derives a
  conservative WooCommerce core target set, and returns a new `STATUS_WRITE`
  reference.
- `POST /api/internal/telegram/orders/status` verifies signature, purpose,
  expiry, target binding, first-target claim, live context, role, Store, and
  Order before any external write.
- Migration `20260724090000_telegram_order_status_write` extends the existing
  callback-reference model with allowed/claimed targets and adds durable
  reference-plus-target write records. The complete eight-migration chain
  applied cleanly to an isolated PostgreSQL database and Prisma reported it up
  to date.
- Duplicate and delayed callbacks return the persisted result without a second
  WooCommerce write; a write reference cannot be reused for a different
  target.
- The backend reads live WooCommerce state, revalidates the transition, and
  dispatches one status update without automatic write retry. A missing
  response is resolved through a live single-order read before success is
  reported.
- WooCommerce update/read payloads reconcile through the authoritative M9
  projection path. Successful writes create secret-safe audit records.
- The grammY bot renders only backend-provided targets, forwards the selected
  target, and retains M11 edit-to-reply fallback. It has no Prisma, database,
  WooCommerce, or status-policy logic.
- Phase 4 stays open until M12 is merged, validated against a real WooCommerce
  store, and accepted by A.

---

## 5. Current Repository Structure

Core documents are under `docs/`. The current scaffold uses `backend/` for the
NestJS API, `telegram-bot/` for the grammY process, and `wp-content/plugins/` for
the lightweight connector. The larger `apps/`, `packages/`, and
`infrastructure/` layout remains a planned target rather than current structure.

---

## 6. Current Blockers

None.

---

## 7. Current Task

M12 — Telegram Order Status Update is implemented and awaiting review. Do not
begin another milestone until M12 is merged, validated against a real
WooCommerce store, and accepted by A.

---

## 8. AI Operating Rules (Must Follow)

Roles:

- **A** — Project owner, architect, final decision maker (Walter)
- **B** — Orchestrator (context, prompts, review, state updates) — currently this document
- **C** — Implementation agent (you, Codex GPT)

Process (strictly sequential):

1. Read all project files
2. Understand current state
3. Implement one task at a time
4. Wait for review/approval before the next task
5. Update `PROJECT_STATE.md` and `DECISIONS.md` (when needed) after each task
6. Commit with a descriptive message

**Hard rules:**

- One task at a time — no skipping, no bundling
- No feature creep
- No architecture changes without explicit approval
- No hidden work
- No new dependencies without justification
- Every completed task must include: updated `PROJECT_STATE.md`, Git commit,
  and `DECISIONS.md` entry if a new decision was made

---

## 9. Multi-Tenancy & Security Requirements (Non-Negotiable)

- Every DB query must be tenant-scoped — never rely solely on `user_id` or `order_id`
- Queue jobs must carry and validate `tenant_id` and `store_id`
- Telegram callbacks must resolve to the correct tenant and authorized user
- Authorization is based on Membership role, not just possession of a chat ID
- Tenant A must never read or affect Tenant B data
- Credentials (WooCommerce keys, webhook secrets, bot tokens) must be encrypted at rest
- No secrets in commits, logs, telemetry, or Telegram messages
- Webhook events must be idempotent (use `dedupe_key`)
- All state-changing actions must produce an AuditLog record

---

## 10. Production Flow (Reference)

WooCommerce Store→ WordPress connector plugin (lightweight)
→ Authenticated webhook/event delivery
→ NestJS API (webhook ingress + HTTP API)
→ Redis-backed BullMQ queue
→ Workers (event processing, WC calls, Telegram delivery, reports, retries)
→ Telegram Bot API (grammY)
→ PostgreSQL (tenant data, state, audit)
→ Redis (queues, cache, rate limits, transient conversation state)

---

_End of handoff document._
