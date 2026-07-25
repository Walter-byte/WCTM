# Phase Breakdown

This document expands the approved phases in `docs/MASTER-ROADMAP.md` into
implementation tasks. Work proceeds one approved task at a time; later phases
remain planned.

## Phase 0 — Foundation ✅ Complete

- Product vision, production architecture, technology stack, core documentation,
  and AI operating workflow established.

## Phase 1 — Project Initialization ✅ Complete

### Task 1.1 — Repository and Docker scaffold

- Monorepo workspaces, NestJS backend, grammY bot, connector plugin, Docker
  Compose services, Caddy, shared TypeScript configuration, and environment
  template created.

### Task 1.2 — Prisma integration and core schema

- Prisma 7 configured with PostgreSQL.
- Initial six-model multi-tenant schema and `init_schema` migration created.

### Task 1.3 — NestJS Prisma integration

- Global `PrismaModule` and lifecycle-managed `PrismaService` added.
- Graceful NestJS shutdown hooks enabled.

### Task 1.4 — Clean-environment verification and closure

- Clean clone built and ran successfully with PostgreSQL, Redis, bot, and Caddy.
- Initial migration deployed and verified in sync.
- Compose network isolation, environment naming, smoke testing, and basic CI
  completed.
- Phase 1 documentation synchronized.

Exit criterion met on 2026-07-20: the project builds successfully on a clean
machine.

## Phase 2 — Backend Core ✅ Complete

### Task 2.1 — Configuration foundation ✅ Complete

- Global NestJS configuration module with typed accessors
- Aggregated fail-fast environment validation
- Explicit development, test, and production boundaries
- Secret-safe serialization and error reporting
- Focused configuration tests and synchronized environment documentation

### Task 2.2 — Authentication foundation ✅ Complete

- Access-token-only JWT signing and verification through typed configuration
- Passport JWT bearer strategy and deny-by-default global authentication guard
- Explicit `@Public()` route opt-out and `@CurrentUser()` payload access
- Focused configuration, token, expiry, guard, and public-route tests

### M1 — Database & Application Foundation ✅ Complete

- Structured JSON logging with configured levels and secret redaction
- Correlation IDs carried through the shared request AsyncLocalStorage context
- Normalized global error responses with request IDs
- Focused common-infrastructure tests

### M2 — Multi-Tenant Core ✅ Complete

- Tenant context containing authenticated tenant, user, and membership role
- Active Membership resolution after JWT authentication with `@Public()` bypass
- Global membership enforcement and minimal role requirement metadata
- TenantScopedPrisma Store access with server-side tenant filters on reads and
  writes
- Tests proving context resolution, 403 rejection, public bypass, and
  cross-tenant read/write isolation

### M3 — User & Tenant Management ✅ Complete

- Persisted own-profile read and display-name update operations
- Tenant creation with atomic creator-as-OWNER membership provisioning
- Tenant read, metadata update, and soft deletion through tenant-scoped access
- Membership add/list, role update, and soft deletion for existing users
- `MembershipRole` enum with `OWNER`, `ADMIN`, and `MEMBER`
- Owner/admin management boundaries and last-active-owner protection
- Joi-validated DTOs plus unit and authorization integration tests

### M4 — WooCommerce Store Management ✅ Complete

- AES-256-GCM credential encryption through `ApplicationConfigService`
- Per-request WooCommerce REST client with a safe connection result
- Tenant-scoped Store create, list, read, update, and soft-delete operations
- Role enforcement: all members may read/test; OWNER and ADMIN may mutate
- Explicit safe response selections that never expose credential fields

Acceptance checklist:

- [x] Create stores with encrypted credentials and sanitized responses
- [x] List and read only active stores in the authenticated tenant
- [x] Return 404 for missing, deleted, or cross-tenant stores
- [x] Re-encrypt updated credential fields
- [x] Soft-delete stores and reject repeated deletion
- [x] Return safe success/failure results from connection tests
- [x] Pass 11 focused encryption, CRUD, isolation, and authorization tests

### M5 — Production Operations Foundation ✅ Complete

- Append-only, tenant-context-derived audit events for membership and store
  lifecycle operations
- Allowlisted audit metadata that excludes credentials and sensitive payloads
- One BullMQ operations queue, reference producer, and in-process worker
- Tenant/store job payload validation with three bounded exponential attempts
- Terminal failure logging and graceful queue/worker shutdown
- Public PostgreSQL/Redis readiness endpoint; existing liveness endpoint retained
- Local and production operational runbooks

Acceptance checklist:

- [x] Tenant-scoped mutations create secret-safe AuditLog records
- [x] Reference jobs enqueue, execute, retry, and fail terminally within bounds
- [x] Missing or invalid tenant identity is rejected
- [x] Readiness reflects PostgreSQL and Redis availability
- [x] Queue and worker connections close through Nest shutdown hooks
- [x] No schema migration is required

Phase 2 is complete.

## Phase 3 — WooCommerce Integration ✅ Complete

### M6 — REST Client Hardening & Credential Validation ✅ Complete

- WooCommerce probes use typed configuration for a 5-second attempt timeout,
  15-second total cap, and three attempts with 300/600ms exponential backoff
  plus ±20% jitter.
- Retries are limited to transport failures, timeouts, HTTP 429, and HTTP 5xx;
  authentication and other HTTP 4xx failures fail fast.
- Failures normalize to secret-safe `auth`, `not-found`, `transport`,
  `rate-limited`, `timeout`, or `unexpected` categories.
- Store creation validates live credentials before persistence, and credential
  updates validate the proposed credential set before changing any Store data.
- The existing connection-test response contract remains unchanged.

Acceptance checklist:

- [x] Invalid credentials prevent Store creation
- [x] Failed credential updates preserve existing encrypted credentials
- [x] Successful validation precedes persistence
- [x] Retry, timeout, hard-cap, error mapping, and secret safety are tested
- [x] No schema migration or new dependency is required

### M7 — Plugin Communication & Store Registration (MVP) ✅ Complete

- Existing tenant Stores receive OWNER/ADMIN-issued, 15-minute, single-use
  registration tokens stored only as SHA-256 hashes.
- Public plugin registration derives Store identity only from the token, applies
  an endpoint-scoped Redis fixed-window limit, and verifies the Store through
  the M6 WooCommerce REST client.
- Successful finalization atomically consumes the token, stores a hashed
  plugin→SaaS credential, records registration/health timestamps, and promotes
  the Store from `PENDING` to `ACTIVE`.
- Authentication and transient verification failures preserve the token,
  WooCommerce credentials, plugin credential, status, and health state.
- OWNER, ADMIN, and MEMBER may read tenant-scoped connection health without
  secret fields.

Acceptance checklist:

- [x] Token issuance is tenant-scoped, role-protected, expiring, and single-use
- [x] Replay, expiry, auth failure, and transient failure return generic errors
- [x] Concurrent duplicate finalization produces one credential and one commit
- [x] Registration is rate-limited only at `POST /plugin/register`
- [x] Credential/channel boundaries and secret-safe responses are tested
- [x] Migration `20260722142357_store_registration_handshake` is applied cleanly

### M8 — WooCommerce Webhook Verification & Idempotent Ingestion ✅ Complete

- Dedicated server-generated webhook secrets are AES-256-GCM encrypted and
  remain separate from plugin credentials. Unique opaque endpoint keys route
  webhook requests but do not authenticate them.
- M7 registration atomically provisions missing webhook credentials and returns
  them once. OWNER and ADMIN members can provision missing credentials or
  rotate both values; rotation invalidates the prior secret and endpoint key
  immediately.
- Public WooCommerce ingress resolves an active Store by endpoint key, validates
  required WooCommerce headers, verifies the exact raw request bytes with
  length-guarded constant-time HMAC-SHA256 comparison, and parses JSON only
  after successful authentication.
- Verified envelopes are tenant/store-scoped from server state, deduplicated by
  Store and delivery ID, persisted as `RECEIVED`, and recoverably enqueued as
  `woocommerce.webhook.process` on the existing `operations` queue.
- Deterministic BullMQ job IDs prevent duplicate publication. Existing
  `RECEIVED` events retry enqueue after a prior queue failure; all later
  lifecycle states acknowledge redelivery without another row or job.
- The M8 worker advances only `RECEIVED → QUEUED → PROCESSING → COMPLETED` or
  terminal `FAILED` lifecycle state with the existing three-attempt exponential
  retry policy. Domain synchronization remains deferred to M9.

Acceptance checklist:

- [x] Unknown routes and malformed or unauthenticated deliveries fail closed
- [x] HMAC verification uses exact raw bytes and never authenticates by endpoint key
- [x] Tenant and Store identity come only from the routed Store
- [x] `{storeId, deliveryId}` persistence and deterministic job IDs are idempotent
- [x] Persist-success/enqueue-failure remains recoverable through `RECEIVED`
- [x] Retry exhaustion records `FAILED` and emits secret-safe structured logs
- [x] OWNER/ADMIN provisioning and rotation never re-expose an existing secret
- [x] Migration `20260723120000_woocommerce_webhook_ingestion` applies cleanly
- [x] No order, product, customer, inventory, or other M9 sync behavior is included

Exit criterion met on 2026-07-23: a signed WooCommerce delivery is routed by
opaque endpoint key, authenticated over exact raw bytes, persisted once with
server-derived tenant/Store identity, and recoverably published once to the M5
queue while malformed, unauthenticated, and duplicate deliveries follow their
defined fail-closed or acknowledgment paths.

### M9 — Order Webhook Projection & Single-Order Reconciliation ✅ Complete

- Verified `order.created`, `order.updated`, `order.deleted`, and
  `order.restored` events project into tenant/Store-scoped Order records.
- Store and tenant identity come only from the persisted WebhookEvent Store
  relation; payload and queued ownership fields cannot select another Store.
- The `(store_id, wc_order_id)` uniqueness boundary, WooCommerce modification
  timestamps, and stable projection fingerprints provide deterministic
  idempotency and stale/equal-timestamp conflict handling.
- Missing, malformed, or equal-timestamp-conflicting snapshots use one bounded
  M6 REST fetch for that WooCommerce order only. No sweep, polling, historical
  import, or outbound WooCommerce write is included.
- A 30-second processing lease reclaims abandoned `PROCESSING` events while
  active leases reject duplicate projection work. Retryable failures return to
  `QUEUED`; terminal or exhausted failures remain `FAILED` with bounded,
  secret-safe diagnostics and attempt counts.
- WooCommerce core verification established that `order.deleted` carries a
  stable ID-only payload and `order.restored` carries the REST order resource.
  Deletes retain the existing snapshot and set `remote_deleted_at`; restores
  re-project and clear it.

Acceptance checklist:

- [x] Order snapshots are tenant/Store-scoped and unique by Store/WooCommerce ID
- [x] Older events and exact duplicates cannot regress Order state
- [x] Equal-timestamp conflicts reconcile one authoritative order
- [x] Missing or malformed timestamps route to bounded reconciliation
- [x] Retryable M6 failures use the existing three BullMQ attempts
- [x] Auth, not-found, malformed, and exhausted failures persist safe diagnostics
- [x] Stale processing leases are reclaimable without duplicating Orders
- [x] Verified delete/restore transitions retain and restore snapshots safely
- [x] Migration `20260723180000_order_projection` applies cleanly
- [x] No Telegram, product, customer, inventory, address model, bulk sync, or
      outbound WooCommerce write is included

Exit criterion met on 2026-07-23: verified WooCommerce order webhooks project
once into Store-scoped Order snapshots, ambiguous state reconciles through one
bounded M6 order fetch, and stalled or failed processing remains recoverable and
diagnosable within the existing operations queue.

Phase 3 closed on 2026-07-23 with M6–M9 complete and its exit criterion
satisfied. No next milestone is assigned.

## Phase 4 — Telegram Platform 🚧 In Progress

- Manager registration, chat authorization, commands, inline keyboards, and
  callback handling

### M10 — Telegram Account Linking & Private-Chat Authorization ✅ Complete

- Backend-owned one-time account-link tokens, Telegram identity persistence,
  private-chat authorization, and active tenant/Store context resolution
- Bot-key-authenticated internal backend API with correlation and Telegram
  update identity propagation
- Stateless grammY long-polling adapter with `/start`, `/status`, and confirmed
  `/unlink`
- Private-chat-only enforcement, update deduplication, transactional redemption,
  and soft revocation
- No order-management logic, Store selection/switching, group support, or
  webhook transport

### M11 — Telegram Order Listing & Detail (read-only) ✅ Complete

- Bot-only internal list and detail endpoints read M9 projections after
  backend-owned Telegram account, private-chat, active Membership, tenant, and
  exactly-one active Store resolution
- OWNER, ADMIN, and MEMBER may read; inactive, deleted, ambiguous, and changed
  contexts return typed safe states
- Fixed eight-row keyset pages order by WooCommerce creation time and order ID,
  with previous/next navigation and a 200-row reachable cap
- Short-lived HMAC-authenticated references bind account, chat, tenant, Store,
  purpose, and order/boundary state without placing raw identifiers in Telegram
  callback data
- `/orders` renders summaries, inline detail, pagination, and back navigation;
  edit failures fall back to a new message
- Freshness uses `Order.lastSyncedAt` and a configurable delayed threshold
- No WooCommerce calls, writes, reconciliation, `/order` direct lookup, Store
  switching, group support, or next-milestone behavior

### M12 — Telegram Order Status Update ✅ Complete / Merged

- OWNER and ADMIN can open a server-derived status menu from an M11 order
  detail; MEMBER remains read-only
- Backend-owned conservative WooCommerce core transition mapping with a live
  status recheck before every write
- Dedicated short-lived `STATUS_WRITE` callback references bind account,
  private chat, tenant, Store, order, allowed targets, and the first claimed
  target
- Durable reference-plus-target idempotency returns prior results and prevents
  duplicate or delayed callbacks from issuing another WooCommerce write
- One WooCommerce write dispatch followed by authoritative M9 projection
  reconciliation; ambiguous responses reconcile through a live single-order
  read before reporting
- Stateless grammY target rendering and forwarding with edit-to-reply fallback
- Migration `20260724090000_telegram_order_status_write`

### M12-V — Pilot Onboarding & Validation Bootstrap ✅ Complete / Merged

- Two private-pilot workspace commands: `pilot:setup` and `pilot:readiness`
- Explicit `PILOT_MODE=true` guard, same-identity idempotency, and refusal of
  unrelated existing User/Tenant bootstrap data
- Atomic first User, Tenant, and OWNER Membership creation with in-memory
  `AuthService` access-token handling
- Hidden WooCommerce credential prompts, fail-closed encrypted Store creation,
  and exactly one `ACTIVE` pilot Store
- Server-generated encrypted webhook secret and endpoint key plus remote
  WooCommerce registration of the four required order topics
- Approved public Caddy HTTPS endpoint gate; localhost, private, non-HTTPS, and
  tunnel-based delivery are unsupported
- One-time Telegram `/start` handoff, manual synthetic-order step, and nine
  bounded readiness checks
- No reset, force, overwrite, data deletion, public onboarding, connector UI,
  billing, or Phase 5 work

Phase 4 remains In Progress. M12-V is complete and merged to `main`; M12
real-store validation has not yet been executed. No M13 or other product
milestone is assigned. The next operator action is to deploy current `main` to
the approved VPS, run `pilot:setup`, complete Telegram linking, create one
synthetic WooCommerce order, and run `pilot:readiness`.

## Phase 5 — Core Store Management (MVP) ⬜ Planned

- Orders, inventory, customers, payments, reports, and notifications

## Phase 6 — SaaS Platform ⬜ Planned

- Subscriptions, plans, billing, dashboard, tenant administration, and usage limits

## Phase 7 — Production Readiness ⬜ Planned

- Security, performance, monitoring, backups, documentation, testing, and
  deployment

## Phase 8 — Public Launch ⬜ Planned

- Iran launch, feedback collection, onboarding improvements, and UX fixes

## Phase 9 — Global Expansion ⬜ Planned

- Localization, multiple currencies and languages, international payments, and
  marketplace integrations
