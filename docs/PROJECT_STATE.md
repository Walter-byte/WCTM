# PROJECT STATE

Version: 1.0

---

Current Phase

Phase 3 — WooCommerce Integration active. M9 is complete; M8 and M7 are
complete.

---

Current Task

None assigned. M9 is complete, and the next milestone must await A's approval.

---

Project Version

0.1.0

---

Repository

Initialized on branch main.

---

Backend

NestJS scaffold created.

Prisma ORM configured with PostgreSQL.

Initial six-model multi-tenant schema and migration created.

The `init_schema` migration was applied and verified in sync during clean-clone
verification.

Global PrismaModule and lifecycle-managed PrismaService are available for
injection in future backend modules without re-importing PrismaModule.

A backend smoke test verifies that the Nest application boots.

A global ApplicationConfigModule validates the environment before startup and
exposes typed application, PostgreSQL, Redis, JWT, encryption, Telegram, and
WooCommerce settings through ApplicationConfigService. Validation aggregates
failures, enforces development/test/production boundaries, and redacts secrets.

An AuthModule provides access-token signing and verification, Passport JWT
bearer validation, a global deny-by-default authentication guard, `@Public()`
route opt-out, and `@CurrentUser()` payload access. User persistence, login,
refresh tokens, RBAC, and tenant authorization remain outside Task 2.2.

Global backend infrastructure under `backend/src/common/` provides structured
JSON logging at the configured `LOG_LEVEL`, secret redaction, AsyncLocalStorage
request context with generated or preserved `x-request-id` correlation IDs, and
a normalized global error contract containing `statusCode`, `error`, `message`,
and `requestId`. The common layer contains cross-cutting infrastructure only.

The M2 tenant foundation extends that same request AsyncLocalStorage context
with the authenticated `tenantId`, `userId`, and membership role. A global guard
resolves active Membership records after JWT authentication, rejects missing or
unauthorized memberships, and skips explicit `@Public()` routes. Tenant-owned
Store access demonstrates the required TenantScopedPrisma pattern: tenant IDs
come only from server-side context and are injected into every read and write.

M3 adds persisted own-profile access, tenant creation with atomic OWNER
provisioning, tenant metadata and soft-delete operations, and tenant-scoped
membership listing, addition, role updates, and soft deletion. Membership roles
are constrained by the Prisma `MembershipRole` enum (`OWNER`, `ADMIN`,
`MEMBER`); serializable membership mutations prevent removing or demoting the
last active OWNER. JWT-protected `@TenantOptional()` routes are limited to own
profile and tenant bootstrap operations.

M4 adds tenant-scoped WooCommerce Store CRUD with soft deletion, AES-256-GCM
credential encryption through the typed application encryption setting, a thin
per-request WooCommerce REST client, and a credential-safe connection test.
Store responses use explicit Prisma selections that omit encrypted fields, and
cross-tenant or deleted records resolve as not found.

M5 adds append-only audit event creation for membership and store operations,
with tenant and actor identity sourced from server request context and strict
metadata allowlisting. One BullMQ operations queue and in-process reference
worker provide validated tenant-aware payloads, bounded exponential retries,
terminal structured error logging, Redis/PostgreSQL readiness checks, and clean
shutdown through Nest lifecycle hooks.

M6 hardens the per-request WooCommerce REST client with typed resilience
configuration, a five-second per-attempt timeout, a 15-second total cap, and up
to three attempts using 300/600ms exponential backoff with ±20% jitter. Retries
are restricted to transport failures, timeouts, HTTP 429, and HTTP 5xx.
WooCommerce failures normalize to six secret-safe categories without retaining
raw request errors or authorization data.

Store creation now validates live reachability and credentials before any Store
row is persisted. Credential-changing updates validate the proposed credential
set before any Store field is mutated, so failed validation preserves the
existing encrypted credentials and metadata. The existing connection-test
response shape is preserved. M6 adds no dependency, schema migration, webhook,
plugin registration, resource endpoint, or synchronization behavior.

M7 adds a single-use plugin registration handshake for pre-existing tenant
Stores. Store creation now persists `PENDING` after M6 WooCommerce REST
validation. OWNER and ADMIN members can issue a short-lived registration token;
only its SHA-256 hash, expiry, and consumption state are stored. The public
registration endpoint derives Store identity only from that token and uses the
M6 WooCommerce REST test—there is no SaaS→plugin probe or plugin endpoint URL.

Successful registration atomically consumes the token, replaces the hashed
persistent plugin→SaaS credential, records registration, last-seen, and
last-healthy timestamps, creates an audit event, and changes Store status to
`ACTIVE`. Auth and transient failures leave all Store state unchanged. A
tenant-scoped connection-health endpoint exposes only status, timestamps, and a
registration boolean. A Redis fixed-window limiter applies only to public
plugin registration.

Store registration fields are introduced by migration
`20260722142357_store_registration_handshake`. The final `StoreStatus` literals
remain `PENDING`, `ACTIVE`, `DISCONNECTED`, and `DISABLED`.

M8 adds dedicated server-generated webhook secrets encrypted through the
existing AES-256-GCM service and unique opaque endpoint keys used only for Store
routing. M7 registration atomically provisions missing webhook credentials;
OWNER and ADMIN members can provision or rotate both values without re-exposing
an existing secret.

The public WooCommerce webhook route resolves an active Store by endpoint key,
validates required WooCommerce headers, verifies HMAC-SHA256 over exact raw
request bytes with a length-guarded constant-time comparison, and parses JSON
only after authentication. Tenant and Store identity always come from the
server-resolved Store.

Verified envelopes persist as `WebhookEvent` records deduplicated by Store and
delivery ID, then enqueue `woocommerce.webhook.process` on the existing
`operations` queue with a deterministic job ID. Enqueue failure leaves the
event `RECEIVED` for recoverable redelivery; later lifecycle states acknowledge
duplicates without another row or job. The worker advances operational state
through `QUEUED`, `PROCESSING`, `COMPLETED`, or terminal `FAILED` only and
performs no domain synchronization.

Migration `20260723120000_woocommerce_webhook_ingestion` was applied cleanly.
D-017 records the credential, authentication, idempotency, recovery, rotation,
scope, and structured-logging boundaries.

M9 adds tenant/Store-scoped Order snapshots with a unique
`(store_id, wc_order_id)` identity boundary. Verified `order.created` and
`order.updated` payloads map order number, status, currency, totals, customer
display data, line items, WooCommerce creation/modification timestamps, and a
canonical SHA-256 projection fingerprint without introducing related product,
customer, inventory, address, or line-item tables.

The M8 `woocommerce.webhook.process` worker now loads identity only through the
WebhookEvent Store relation. Older WooCommerce modification timestamps are
no-ops, newer snapshots apply, exact equal-timestamp duplicates are no-ops, and
equal-timestamp content conflicts reconcile through one bounded M6 order fetch.
Missing or unreliable timestamps and malformed snapshots with a stable order ID
use the same single-order reconciliation path.

WebhookEvent processing has a 30-second lease, attempt counter, normalized
failure category, bounded safe failure code, and last-failure timestamp.
Expired `PROCESSING` work can be reclaimed after a crash; active leases cannot
duplicate projection work. Retryable WooCommerce failures use the existing
three BullMQ attempts, while auth, not-found, malformed, and exhausted failures
remain terminal diagnostic records.

WooCommerce core source verification confirmed stable ID-only
`order.deleted` payloads and full REST-resource `order.restored` payloads. M9
therefore retains the Order snapshot while setting `remote_deleted_at`, and a
restore re-projects the snapshot and clears that marker. Generic reconciliation
not-found results remain terminal.

Migration `20260723180000_order_projection` applied cleanly in an isolated
PostgreSQL database. D-018 records projection ordering, canonical fingerprint,
lease recovery, reconciliation, and verified delete/restore boundaries.

---

Plugin

WooCommerce connector scaffold created. The SaaS-side MVP registration contract
is available; plugin-side UI and implementation remain outside M7.

---

Telegram Bot

grammY scaffold created.

---

Infrastructure

Docker Compose and Caddy scaffolds created.

Compose networking is project-scoped to avoid cross-project collisions.

Basic GitHub Actions CI runs Prisma validation/generation, build, type-check,
lint, formatting, and the backend smoke test.

---

Production Stack

NestJS

PostgreSQL

Redis

BullMQ

grammY

Docker

Caddy

WooCommerce REST API

WooCommerce Webhooks

---

Current Branch

main

---

Known Issues

AuditLog structural immutability is not yet enforced; the schema includes an
updatable timestamp. A future approved decision must define enforcement.

The production backend image omits the Prisma CLI because production dependency
installation excludes the Prisma development dependency. M3 migrations were
verified with the Docker builder stage; the production migration execution path
requires a future approved infrastructure correction.

---

Technical Debt

AuditLog immutability enforcement is deferred to a future approved task.

---

Current Blockers

None

---

Next Milestone

None assigned. Await A's approval before starting another milestone or Phase 4.

---

Last Completed

M9 — Order Webhook Projection & Single-Order Reconciliation.

---

Project Health

Excellent

---

Last Updated

2026-07-23
