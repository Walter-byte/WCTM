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
through `/api/health`. The previously pending M13 deployed synthetic-
notification check later passed through the combined M18 live validation.

## Phase 5 — Core Store Management (MVP) ✅ Complete

- Orders, inventory, customers, payments, reports, and notifications
- The original full MVP scope remains unchanged; Phase 4 closure does not mark
  the full MVP complete

### M17 — Order Workflow Completion ✅ Complete / Merged / Operationally Validated

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
  PostgreSQL 16 and Prisma reports it up to date
- B review returned `MERGE`; production migration
  `20260830120000_m17_order_workflow_completion` applied successfully
- Backend and telegram-bot deployment, `/api/health`, and
  `/api/health/readiness` passed
- Real-Store `/order <known-test-order>`, authoritative Refresh, internal note
  round-trip, and customer-visible note round-trip passed
- Additional live duplicate, MEMBER, cross-tenant, and ambiguous-response tests
  were not required because automated/adversarial coverage was accepted
- M17 operational validation passed and M17 is fully closed

### M18 — MVP Store Settings Foundation ✅ Complete / Merged / Operationally Validated

- Tenant-owned `timezone` and typed `FA`/`EN` language settings; existing
  Tenants backfill to `UTC`/English while new Tenants default to Persian/`UTC`
- Store-owned nullable bounded low-stock threshold, exactly
  `ORDER_CREATED`/`LOW_STOCK` categories, and legacy-compatible
  `ALL_ELIGIBLE` or explicit `SELECTED` recipient mode
- One Store↔Membership recipient mapping with composite same-Tenant foreign
  keys and Store+Membership uniqueness; no Telegram identity is persisted in
  recipient preferences
- Backend-only OWNER/ADMIN mutation and OWNER/ADMIN/MEMBER read authorization
  after current M10 exact-account/private-chat/Membership/Tenant/Store
  resolution
- Stateless `/settings` and Home navigation with compact read-only MEMBER
  summaries, absolute desired-state callbacks, opaque signed references, and
  backend-owned expiring timezone/threshold input contexts
- M13 scheduling skips disabled `ORDER_CREATED`, applies selected-Membership
  intersection, and revalidates category, recipient mode, selected Membership,
  and all existing M10 authorization before dispatch
- Successful state changes emit safe `telegram.settings.updated` AuditLog rows;
  no-op replays emit no misleading duplicate audit
- Migration `20260831120000_m18_store_settings_foundation`; full 12-migration
  chain and seeded existing-row/new-row backfill checks pass on isolated
  PostgreSQL 16
- Final adversarial audit added a database check that rejects duplicate or null
  category-array members; PostgreSQL enum typing continues to reject unsupported
  categories. Real concurrency probes verified duplicate and opposing category/
  recipient requests serialize without duplicate state or misleading no-op audit
- Automated gates pass with 332 Jest backend tests, 24 backend Node
  smoke/contract tests (one PHP-runtime skip), and 45 Telegram bot tests, plus
  Prisma validation/generation, build, typecheck, lint, and focused migration
  constraints
- D-024 records the locked ownership, Membership-recipient, M10/M13, stateless
  bot, and later-milestone exclusion boundaries
- No inventory query/detection, `/stock`, search, report, general localization,
  billing, dashboard, Store switching, connector logic, dependency, queue, or
  service-topology change

Production migration, backend plus telegram-bot deployment, `/api/health`,
`/api/health/readiness`, `/settings`, settings persistence, and timezone
persistence passed. Enabled `ORDER_CREATED` delivery and View Order passed;
disabled delivery was suppressed; re-enabling caused no historical resend; and
the final newly created order produced exactly one Telegram notification in
under one second. Its newest `order.created` WebhookEvent was `COMPLETED` with
`processing_attempt_count = 1`. This combined validation also closes the prior
M13 deployed synthetic-notification item as PASS.

Validation exposed a pre-existing M8/M9 publication race, not an M18 defect.
Commit `892fc925 fix(webhooks): close pre-claim publication race` makes the
worker atomically claim `RECEIVED`, `QUEUED`, or expired `PROCESSING`. The fix
is deployed and production-validated. M18 is fully complete and operationally
validated.

### M19 — Inventory & Low-Stock MVP ✅ Complete / Merged / Operationally Validated

- WooCommerce-authoritative, read-only Store-scoped inventory projection with
  no catalog domain and no inventory mutation path
- Automatic current-state bootstrap from the first `/stock` request or enabled
  `LOW_STOCK` category; bounded 25-row product/variation queue continuations,
  persisted restart progress, and no historical alerts
- Existing M8 webhook path extended only for `product.created`,
  `product.updated`, `product.deleted`, and `product.restored`; connector fresh
  setup and Retry reconcile all eight order/inventory topics with the existing
  endpoint and secret
- Stock-pool ownership prevents parent/inherited-variation duplication while
  retaining independently managed variations and explicit unmanaged
  out-of-stock items
- Exact M18 Store-threshold classification, durable incident generations,
  one LOW/OUT delivery per eligible current recipient, low-to-out escalation,
  recovery rearm, and no back-in-stock delivery
- Stateless read-only `/stock` for OWNER/ADMIN/MEMBER, eight rows per page,
  200-row reachability window, minimized detail, and short-lived context-bound
  signed references
- Migration `20260901120000_m19_inventory_low_stock`; complete chain,
  representative pre-M19 backfill, and tenant/identity/delivery constraints
  pass on isolated PostgreSQL 16
- Corrective migration
  `20260901190000_m19_nullable_managed_stock_quantity` accepts WooCommerce's
  valid managed-stock/null-quantity state without allowing unmanaged numeric
  quantity
- Focused bootstrap, webhook, projection, incident, recipient-policy,
  transport, `/stock`, connector, migration, and M8/M9/M13/M18 regression
  coverage passes; no dependency, queue, worker, scheduler, or service added
- D-025 records the durable M19 architecture and remains Accepted

Production migrations, backend, telegram-bot, and updated connector deployment
passed. Native PHP lint, connector Retry/reconciliation, `/api/health`,
`/api/health/readiness`, onboarding connection health, and exactly eight active
canonical order/product webhooks passed. First `/stock` completed the bounded
bootstrap to `READY` without historical notifications; current low/out items,
signed item detail, managed-null quantity, and the `Unnamed variation` display
fallback passed on the real Store.

Controlled validation passed healthy 10→LOW 5 with exactly one LOW delivery,
repeat LOW 5→4 without duplication, LOW 4→OUT 0 with exactly one OUT escalation,
recovery 0→9 without a back-in-stock delivery, and a new 9→0 incident with
exactly one new OUT delivery. Incident generations 4 and 5 are `DELIVERED`;
older pre-hotfix `bot-request-rejected` rows remain terminal without replay.

Material production corrections are `8f13fd3` for managed-null stock quantity,
`00f4f4c` for safe display-name fallback, `242d72a` for PostgreSQL threshold
rebaseline bind typing, and `ef0957b` for signed `v.` View Stock delivery
callbacks. The pre-existing M8/M9 publication race remains recorded separately
in `892fc925`. M19 is fully complete and operationally validated.

M20 — Search & Daily Report is fully complete, merged, deployed, hotfixed, and
operationally validated. Final implementation merge `0281bb0` and numeric-SKU
hotfix merge `4b66c9a` are on `main`; D-026 remains Accepted without an
architecture change.

- D-026 locks projection-only Store-scoped search across current Order and
  InventoryItem projections, with exact/prefix Order number, projected customer
  display name, SKU, and inventory display name only.
- Deterministic eight-row pagination is capped at 200 results. Unique exact
  Order matches reuse M17 detail; all list/result state is short-lived, signed,
  context-bound, and query state is encrypted. Inventory is explicitly partial
  until M19 is READY.
- On-demand `/report` uses Tenant-local DST-safe day boundaries over
  `wc_created_at`, current status distribution, processing/completed gross and
  AOV separated by currency, and READY-only current LOW/OUT counts.
- Migration `20260903120000_m20_search_daily_report` adds narrow indexes and
  search-reference persistence only. No live Woo report/search read, Customer,
  Product, report snapshot, analytics, scheduler, delivery, historical import,
  M21 localization, or M22 entitlement work was added.
- Production applied the M20 migration with all 15 migrations current, deployed
  backend and telegram-bot, passed health/readiness with clean runtime logs, and
  loaded `/search`, `/search/select`, and `/report`. Exact Order search and M17
  detail, customer-name search, inventory-name prefix search and detail, safe
  empty search, `/order`, and `/stock` passed.
- Production exposed one numeric exact-SKU defect: projected SKU `312` did not
  match after the exact-Order path found no Order. Hotfix
  `c38af6edb2758c8c3f7b5b5a7b696fbf9a658827` adds a typed, Store/Tenant-scoped
  exact-SKU lookup after the unique exact-Order fast path and re-enters global
  ranking at rank 2. Unique exact Order remains rank 1; pagination, prefix,
  ranking, and reference semantics are unchanged. The backend-only deployment
  and production `/search 312` retest passed.
- The 2026-09-03 `Asia/Tehran` report passed with zero Orders, no gross
  operational sales or status distribution, two LOW and 101 OUT items, the
  delayed-projection warning, the projected-operational/non-accounting
  disclaimer, and on-demand-only behavior.
- SKU `604` is projected and searchable. SKU `903` has no current Store
  `InventoryItem` row, so projection-only M20 cannot find it. This is a
  non-blocking production-data/projection limitation, not current evidence of
  an M19 or M20 defect; M20 does not promise complete WooCommerce catalog
  search. Revisit post-MVP only if a real Store reproduces a WCTM projection
  defect.

M20 final decision: PASS.

### M21 — Notification / Localization Completion ✅ Complete / Merged / Operationally Validated

- D-027 locks presentation/localization only: `Tenant.language` is authoritative,
  `fa`/`en` are supported, pre-context UX defaults to Persian, and unknown
  runtime language falls back to English.
- The stateless, database-free telegram-bot owns one typed bilingual catalog and
  renders every existing M10–M20 manager surface plus M13 ORDER_CREATED and M19
  LOW/OUT notifications from backend semantic data.
- Persian rendering uses FSI/PDI isolation for LTR identifiers and Persian-
  calendar `Intl` formatting in the Tenant timezone. English remains Gregorian.
  Values, stored UTC timestamps, M20 report boundaries, and WooCommerce
  authority are unchanged.
- M13/M19 delivery identity, persistence, claims, retries, terminal/ambiguous
  semantics, signed callbacks, M18 categories/modes/recipient policy, and M10
  authorization are unchanged.
- No schema migration, dependency, new queue/process/scheduler, onboarding or
  connector localization, template system, notification category, or M22
  capability was added.
- Implementation commit `a1554a7 feat(localization): complete MVP Telegram
localization` was merged to `main` in `7e3ad24 merge: complete M21
notification localization`. Backend and telegram-bot deployed successfully;
  no migration was required, the connector was unchanged, backend startup was
  clean, bot polling started normally, and `/api/health` plus
  `/api/health/readiness` passed.
- Production language changes through `/settings` took effect immediately.
  Persian Home, order surfaces/actions, `/search`, `/report`, `/stock`,
  `/settings`, `/status`, `/help`, command descriptions, and Back/Home
  navigation passed broadly; Persian-calendar dates used the configured Tenant
  timezone and LTR identifiers remained exact and readable under RTL. Switching
  back to English immediately restored representative English surfaces.
- A Persian `ORDER_CREATED` production notification was delivered successfully,
  with its existing View Order/action behavior functional. Delivery was
  somewhat delayed but completed, and language changes caused no duplicate or
  historical order/inventory replay.
- The bounded LOW live attempt remained `OUT_OF_STOCK`, not LOW: production
  state was `stock_quantity = 1`, Woo `stock_status = outofstock`, WCTM
  `alert_classification = OUT_OF_STOCK`, incident generation 5. Under M19,
  explicit Woo `outofstock` is authoritative regardless of numeric quantity.
  The accepted `product.updated` WebhookEvent completed and updated the
  projection, so no genuine HEALTHY to LOW_STOCK transition occurred and no new
  LOW delivery row was expected. Automated localized LOW/OUT prepared-
  notification coverage is accepted for closure; this is not an M21 defect or
  a failed LOW notification.

M21 final decision: PASS.

### M22 — Basic MVP Entitlements & Phase 5 Closure ✅ Complete / Merged / Operationally Validated

- D-028 adds one Tenant service-access lifecycle only. Existing plans remain
  exactly `FREE`, `PRO`, and `AGENCY`, informational and behaviorally identical
  in M22; no plan matrix, feature keys, commercial quotas, or second plan model
  exist.
- Migration `20260904120000_m22_basic_mvp_entitlements` adds persisted
  `ACTIVE`/`SUSPENDED`, ACTIVE default, and nullable UTC expiry. EXPIRED is
  derived at the exact expiry instant; SUSPENDED overrides expiry. Existing and
  new Tenants are ACTIVE with no expiry.
- Current PostgreSQL state is authoritative through one Nest entitlement
  service. JWTs, Telegram/callback input, onboarding requests, WooCommerce, the
  connector, and Redis carry no trusted entitlement state.
- The operator-only `entitlement:manage` application-context command inspects,
  activates, suspends, sets an explicit UTC expiry, or clears expiry for one
  explicit non-deleted Tenant. Safe AuditLog and structured fingerprinted event
  output use no user, customer, Telegram, credential, or Store-secret data.
- Normal Store creation, M7 issuance/finalization, M10 issuance/redemption,
  operational Order reads/actions, `/search`, `/report`, `/stock`, and M18
  mutations require current ACTIVE access. Signed references first retain their
  existing signature, TTL, context, and role checks; protected Woo writes check
  entitlement again immediately before dispatch.
- `/status`, `/help`, confirmed `/unlink`, and read-only `/settings` remain
  available. Status/settings expose sanitized plan/effective-state/expiry;
  inactive settings emit no mutation references. M21's one typed `fa`/`en`
  catalog owns denial and recovery presentation with Tenant-timezone Persian or
  Gregorian expiry formatting.
- M8 webhook authentication, durable ingestion/deduplication, M9 Order
  projection, and M19 product projection continue while inactive. Credentials,
  webhooks, Stores, links, settings, projections, incidents, and history remain
  intact; the connector has no entitlement policy change.
- M13/M19 schedule no new delivery while inactive and revalidate before
  preparation and Telegram dispatch. A captured delivery that becomes inactive
  is terminal/non-retry with safe `entitlement-inactive`; reactivation never
  resurrects historical suppressed, delivered, terminal, or ambiguous work.
- Implementation commit `35f9e72335c8ed0c6a039497d92bed763dc68fb5`
  (`feat(entitlements): add MVP tenant entitlement gate`) was merged to `main`
  in `c231437` (`merge: complete M22 basic MVP entitlements`).
- Automated implementation gates pass: the full 16-migration chain and current
  status on isolated PostgreSQL 16, representative existing/new Tenant
  ACTIVE/null-expiry probes, end-to-end operator lifecycle, backend build, 459
  Jest tests, 24 backend Node/connector contract passes with one unavailable-PHP
  skip, 67 bot tests, Prisma format/validate/generate, typecheck, and lint.

Production closure evidence:

- Migration `20260904120000_m22_basic_mvp_entitlements` applied successfully;
  the complete production chain passed with all 16 migrations current, and the
  existing Tenant backfilled to ACTIVE with no expiry.
- Backend and telegram-bot deployed with clean startup, EntitlementsModule
  initialization, normal bot polling, and passing `/api/health` and
  `/api/health/readiness`; the connector required no deployment.
- The production Tenant began as FREE/ACTIVE with no expiry. Operator inspect,
  ACTIVE `/status` and `/orders`, and issuance of a signed operational reference
  passed.
- The operator changed ACTIVE to SUSPENDED, emitted the safe bounded Tenant-
  fingerprint event, and inspect confirmed persisted/effective SUSPENDED with
  no expiry. `/status` and read-only `/settings` remained available; mutation
  controls were absent; `/orders`, `/search`, `/report`, `/stock`, and the
  previously issued operational callback were denied with correct localized
  Persian UX and no protected WooCommerce operation.
- Synthetic WooCommerce order `17870` was created while suspended. Its
  authenticated `order.created` WebhookEvent completed, M9 projection
  succeeded, and the Order appeared in the projection. No M13 delivery row was
  created, attempted, or sent, proving inactive scheduling suppression while
  webhook authentication and projection continuity remained operational.
- Reactivation restored FREE/ACTIVE with no expiry without rebuilding the
  Store, webhook, link, projection, or settings. The existing Telegram link and
  suspended-period Order remained visible; `/orders` and representative
  `/search`, `/report`, and `/stock` behavior resumed. No historical
  notification for Order `17870` replayed.
- Final health and readiness passed with PostgreSQL and Redis up and no
  entitlement/runtime error. One isolated webhook `401 Unauthorized` occurred
  during validation, but independently successful authenticated processing and
  projection proved the accepted path.
- Order `17870` projected an abnormal `wc_created_at` year `2647`. This remains
  DATE-001 for later Phase 7 production-readiness investigation and is not an
  M22 failure.

M22 final decision: PASS. Phase 5 final decision: COMPLETE. M17–M22 and all
approved MVP Telegram product features are complete, Persian/English manager UX
and backend-authoritative entitlement enforcement are operational, and no open
Phase-5 feature blocker remains. Phase 6 commercial SaaS work has not started;
Phase 7 production-readiness is now current by D-029, and unrestricted public
launch is not approved.

## Phase 7 — Production Readiness 🔵 Current

### P7.1 — Production Security Baseline 🟡 Implemented; awaiting review and production validation

- Complete runtime configuration and secret-boundary inventory, with production
  rejection of committed placeholders, unsafe pilot/log settings, and unrelated
  secret reuse.
- Secret-safe `security:config-audit` command using the typed configuration
  boundary and reporting names/categories plus PASS/FAIL only.
- Central configured-secret and privacy-field logging redaction, query-free
  request logging, and sentinel regressions.
- Same-origin onboarding CSP/security headers, explicit 64 KiB application-body
  and 1 MiB exact raw-webhook limits, and no wildcard CORS/cookie/browser
  persistence change.
- Loopback backend publication; private PostgreSQL, Redis, and bot; exact
  host-Caddy/HSTS, firewall, sshd, Docker, readiness, DB-role, log, and CI
  validation runbook.
- Backend/bot non-root runtime stages, development/optional-package-free backend
  runtime, current dependency audit, and bounded repository/history/provenance
  audits.
- Exact connector token validation plus preserved capability, nonce, escaping,
  hidden/autoload-disabled material, direct-origin, and M7/M8 reconciliation.
- DML-only runtime PostgreSQL procedure derived from the current M1-M22 schema;
  P7.2 retains ownership of the final migration role/path.

P7.1 remains operationally open until B review and A-owned production checks.
Node.js 20 passed upstream EOL on 2026-04-30 and is an explicit public-launch
blocker pending a separately approved supported-major migration and reproducible
base-image version/digest pinning. The initial
release-provenance audit found pre-existing implementation-agent naming in
tracked canonical documents/history; no history rewrite is authorized. P7.2
through P7.8 are unstarted.

### Approved Phase 7 order

1. P7.1 — Production Security Baseline
2. P7.2 — Production Migration & Deployment Path
3. P7.3 — Backup, Restore & Disaster Recovery
4. P7.4 — Monitoring & Alerting
5. P7.5 — Data & Time Correctness
6. P7.6 — Network & Runtime Reliability
7. P7.7 — Audit & Operational Integrity
8. P7.8 — Final Launch Readiness Gate

## Phase 6 — SaaS Platform ⬜ Deferred / unstarted

- Subscriptions, plans, billing, dashboard, tenant administration, and usage
  limits remain deferred until Phase 7 completes and A separately authorizes
  Phase 6.

## Phase 8 — Public Launch ⬜ Planned

- Iran launch, feedback collection, onboarding improvements, and UX fixes

## Phase 9 — Global Expansion ⬜ Planned

- Localization, multiple currencies and languages, international payments, and
  marketplace integrations
