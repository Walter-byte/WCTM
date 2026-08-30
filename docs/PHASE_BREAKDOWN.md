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
  plugin→SaaS credential, records registration/last-seen time, and provisions
  missing M8 material while promoting the Store from `PENDING` to `ACTIVE`.
  Under the M16 extension, connector webhook verification separately records
  health evidence and does not own that lifecycle transition.
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
satisfied. Phase 4 followed and is now complete.

## Phase 4 — Telegram Platform ✅ Complete

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

### M13 — Order Event Notifications ✅ Complete / Merged

- Successfully projected `order.created` events discover recipients through
  the existing M10/M11 exact-context authorization behavior
- One durable delivery per Order/private-chat authorization with explicit
  pending, in-flight, delivered, retryable, terminal, and ambiguous states
- Deterministic delivery jobs reuse the M5 `operations` queue and bounded retry
  policy only for definitive transient no-delivery outcomes
- Pre-dispatch authorization and tenant/Store context are revalidated from
  current backend state
- Compact sanitized new-order messages create native M11 View Order references
  and expose the unchanged M12 Change Status entry only when permitted
- The stateless grammY process remains the sole Telegram API transport through
  one private `BOT_INTERNAL_API_KEY`-authenticated prepared-message operation
- Migration `20260820090000_order_event_notifications`; D-023 Accepted

### M14 — Practical Telegram Management UX ✅ Complete / Merged

- One stateless Home surface connects Recent Orders, Status, and Help without a
  second navigation or business-state system
- `/start`, `/status`, `/orders`, `/help`, and the Telegram command menu expose
  only existing M10–M13 functionality
- Existing signed list/detail/status references retain Back continuity from
  M13 notifications through M11 detail and M12 status actions
- Empty, expired, context-changed, unauthorized, no-active-Store, transport,
  and status-result screens provide explicit safe recovery actions
- Labels, keyboards, message editing, and edit-to-reply fallback are consistent
  across command, notification, list, detail, and status surfaces
- No schema, persistence, backend contract, authorization, callback-security,
  order, notification, mutation, or Store-selection behavior changes
- Focused M14 tests plus M10–M13 regressions and repository quality gates pass

### M15 — Public Account Authentication Foundation ✅ Complete / Merged

- Public register/login routes create or authenticate only a normalized User
- Argon2id password hashes, safe equivalent login failures, and independent
  endpoint-scoped Redis fixed-window limits
- Existing AuthService JWT format with a User subject and no tenant context
- M3 remains the sole first-Tenant and atomic OWNER bootstrap
- Migration `20260828120000_public_account_authentication`

### M16 — Self-Service Store Onboarding ✅ Complete / Merged / Live-Validated

- Exact-one active Membership bridge issues the existing tenant-context JWT;
  zero Memberships require M3 bootstrap and multiple Memberships fail safely
- Framework-free same-origin onboarding surface keeps JWTs in memory, submits
  WooCommerce credentials without browser persistence, and exposes only the
  approved account, Tenant, Store, M7, health, and M10 ceremony
- Fresh M7 registration provisions the current M8 response material and
  preserves the established Store transition to `ACTIVE`; the connector
  persists secrets with autoload disabled, installs and verifies all four order
  webhooks, then authenticates a backend verification that records health
  without owning the lifecycle transition
- M10 token issuance is backend-denied until exact-one Tenant and exact-one
  ACTIVE/healthy Store eligibility is established
- WordPress connector 0.2.2 uses the approved direct connector HTTPS origin for
  restricted/Iran-hosted networks, supports WooCommerce's proxied
  `WC_Data_Store`, reconciles duplicate canonical hooks, restores the persisted
  M8 secret, and keeps Retry idempotent
- A verified that exactly four current connector-owned order hooks remained
  after obsolete private-pilot hooks were removed; real signed M8
  `order.created` delivery was accepted with HTTP 200
- The stale pilot Telegram identity conflict was fixed; fresh M10 linking,
  `/status`, `/orders`, order detail, Back/Home, and replay rejection passed
- No onboarding persistence, general dashboard, selection/switching, billing,
  new order behavior, or later milestone scope

Phase 4 closed on 2026-08-30. B returned MERGE, A live validation passed, and
M16 was merged to `main` in `9e831a9`, deployed to the VPS, and smoke-tested
through `/api/health`. The separate M13 deployed synthetic-notification check
is not recorded as PASS by this validation.

## Phase 5 — Core Store Management (MVP) 🟨 In Progress

- Orders, inventory, customers, payments, reports, and notifications
- The original full MVP scope remains unchanged; Phase 4 closure does not mark
  the full MVP complete

### M17 — Order Workflow Completion ✅ Implemented / Awaiting Review

- Exact `/order <number>` lookup against the current backend-resolved Store,
  with safe malformed, absent, ambiguous-exact, deleted, unauthorized, and
  context-changed outcomes
- OWNER, ADMIN, and MEMBER read access through the existing M11 detail and
  signed-reference contract
- One user-initiated authoritative M6 order refresh reconciled only through M9,
  with no polling, alternate sync service, or background refresh path
- Minimized payment method and paid/unpaid context plus shipping method and
  fulfillment address lines; no transaction ID or contact fields
- OWNER/ADMIN internal and customer-visible WooCommerce notes with bounded
  plain-text entry, safe preview, mandatory confirmation, and cancellation;
  MEMBER remains read-only
- Stateless grammY transport using backend-owned short-lived context references,
  encrypted transient draft content, and no bot database/session state
- Purpose-specific durable note claims and results, one non-retried external
  POST, safe replay, ambiguous-outcome protection, and secret-safe success audit
- Migration `20260830120000_m17_order_workflow_completion`; no dependency,
  Customer/Payment/Shipping model, workflow engine, queue, or service topology
  added
- Automated gates pass; the full migration chain applies cleanly to isolated
  PostgreSQL 16 and Prisma reports it up to date; live WooCommerce/Telegram
  refresh/note validation remains pending

Do not begin another Phase 5 milestone without approval.

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
