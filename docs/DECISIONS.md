# DECISIONS

Every architectural or product decision is recorded here.

---

## D-001

Date

2026-07-18

Decision

Project will be developed as a production SaaS.

Status

Accepted.

---

## D-002

Decision

Production backend uses NestJS.

Alternative

Fastify.

Reason

Excellent modular architecture and ecosystem.

Status

Accepted.

---

## D-003

Decision

Database is PostgreSQL.

Status

Accepted.

---

## D-004

Decision

Redis is mandatory.

Purpose

Caching

Queues

Sessions

Rate limiting

---

## D-005

Decision

BullMQ handles asynchronous jobs.

---

## D-006

Decision

WooCommerce integration uses REST API and Webhooks.

---

## D-007

Decision

Telegram is the primary management interface.

WordPress dashboard becomes optional for daily operations.

---

## D-008

Decision

n8n is NOT part of production architecture.

Purpose

Prototype only.

---

## D-009

Decision

WordPress plugin remains lightweight.

Purpose

Authentication

Registration

Webhook management

Connection health

---

## D-010

Decision

Architecture follows simplicity-first principles.

No overengineering.

No unnecessary abstractions.

No premature optimization.

---

## D-011

Date

2026-07-18

Decision

Prisma is the ORM and database access layer, with PostgreSQL as the database
and Prisma Migrate as the migration mechanism.

Alternative

TypeORM and Drizzle.

Reason

Strong type safety, cleaner schema management, better AI-assisted development,
easier long-term maintenance for a SaaS product, and good PostgreSQL support.

Purpose

Typed database access.

Explicit, versioned schema migrations.

Single source of truth for the data model in schema.prisma.

Every model carries created_at / updated_at.

Important SaaS entities (Tenant, Store, Membership) use soft-delete, not hard delete.

Tenant isolation, RBAC, encryption, and idempotency remain application-layer
responsibilities; the schema encodes them structurally where possible.

Status

Accepted.

---

## D-012

Date

2026-07-19

Decision

The NestJS PrismaService uses Prisma's official PostgreSQL driver adapter.

Reason

Prisma 7 requires a driver adapter when constructing PrismaClient with the
client engine.

Status

Accepted.

---

## D-013

Date

2026-07-20

Decision

Backend environment configuration is centralized in a global NestJS
ApplicationConfigModule. It uses `@nestjs/config` for framework integration and
Joi for validation, with application consumers restricted to the typed
ApplicationConfigService.

Reason

`@nestjs/config` matches the NestJS 11 architecture already in use. Joi provides
declarative conversion, environment-specific rules, and aggregated validation
without introducing a custom validation framework. A custom error formatter
ensures secret values never appear in validation output.

Boundary

Raw environment access is limited to the configuration validation boundary and
the standalone Prisma CLI configuration. Application bootstrap and services use
typed configuration accessors.

Status

Accepted.

---

## D-014

Date

2026-07-21

Decision

The initial background-job topology uses one BullMQ `operations` queue and one
in-process worker managed by the NestJS backend lifecycle. Reference jobs have
three total attempts with exponential backoff starting at one second. Exhausted
jobs remain in BullMQ's failed set and emit a structured, secret-safe error log.

Reason

This is the minimum production-operable topology for the current modular
backend. It proves enqueue, processing, bounded retry, failure visibility, and
graceful shutdown without adding a separate deployment process before business
workers exist.

Boundary

Every job payload is validated and carries `tenantId`, plus `storeId` when
relevant. Splitting workers into a separate process or changing retry policy
requires a later approved task.

Status

Accepted.

---

## D-015

Date

2026-07-22

Decision

WooCommerce REST validation uses three total attempts, a five-second timeout per
attempt, and a 15-second hard operation cap. Retry delays use exponential
backoff starting at 300 milliseconds with factor two and ±20% jitter. Only
transport failures, timeouts, HTTP 429, and HTTP 5xx are retried.

Store creation must validate live WooCommerce reachability and authentication
before persistence. A credential-changing Store update must validate the
proposed credential set before replacing encrypted values; every validation
failure fails the operation without mutating the Store.

Reason

Fail-closed validation prevents unusable or unverified credentials from becoming
active tenant data while bounded retries tolerate transient WooCommerce and
network failures without extending request duration indefinitely.

Boundary

Failures normalize to the secret-safe categories `auth`, `not-found`,
`transport`, `rate-limited`, `timeout`, and `unexpected`. This decision adds no
WooCommerce resource operations, webhook behavior, plugin registration, sync
service, dependency, or schema change.

Status

Accepted.

---

## D-016

Date

2026-07-22

Decision

MVP plugin registration verifies Store reachability and authentication only
through the existing SaaS→WooCommerce REST client. There is no SaaS→plugin
probe, plugin endpoint URL, or plugin-channel verification.

Registration tokens are one-time, TTL-bounded handshake credentials stored as
SHA-256 hashes. Successful registration returns a separate persistent
plugin→SaaS credential exactly once and stores only its SHA-256 hash. If the
success response is lost, an OWNER or ADMIN must issue a new registration token;
successful re-registration generates a new plugin credential and replaces the
prior hash. Replaying the consumed token never reproduces or rotates a
credential.

`POST /plugin/register` alone uses a minimal Redis fixed-window rate limiter
keyed by a hash of client IP plus the registration-token hash prefix. The limit
and window are typed configuration values; no global throttling guard is added.

Reason

These boundaries keep WooCommerce REST authentication, one-time registration,
and persistent plugin authentication independent; preserve recoverable,
single-use plaintext handling; and bound public registration abuse without
expanding application-wide rate-limiting scope.

Status

Accepted.

---

## D-017

Date

2026-07-23

Decision

WooCommerce webhook authentication uses a dedicated server-generated secret of
at least 32 random bytes, encrypted at rest with the existing AES-256-GCM
application encryption service. It is never derived from or shared with the
persistent plugin credential.

Each Store receives a separate unique, indexed, URL-safe
`webhook_endpoint_key`. The endpoint key is opaque routing information only; it
is not an authentication factor. Authentication is exclusively
`base64(HMAC-SHA256(rawBody, webhookSecret))`, verified over the exact request
bytes with a length guard and constant-time comparison.

Verified events are deduplicated by the database constraint on Store ID and
WooCommerce delivery ID. Publication uses a deterministic BullMQ job ID derived
from the persisted WebhookEvent ID. Persistence and enqueueing are a recoverable
two-step operation: persist `RECEIVED`, enqueue on the existing `operations`
queue, then mark `QUEUED`. Enqueue failure leaves `RECEIVED` for an idempotent
WooCommerce redelivery.

OWNER and ADMIN memberships may provision missing webhook credentials or rotate
both the secret and endpoint key. Rotation replaces both values atomically and
the prior secret stops authenticating immediately. Newly generated plaintext
secrets are returned once; existing secrets are never re-exposed.

Reason

Separating routing from authentication and separating webhook credentials from
plugin credentials limits credential reuse and makes rotation explicit. The
database uniqueness constraint plus deterministic queue identity handles
at-least-once delivery without requiring a distributed transaction between
PostgreSQL and Redis.

Boundary

M8 persists and schedules verified envelopes only. Its worker advances
operational lifecycle state with the existing bounded retry/dead-letter policy
and performs no order, product, customer, inventory, or other domain
synchronization. Monitoring remains existing correlation-aware structured logs;
no metrics platform, metrics endpoint, or readiness dead-letter count is added.

Status

Accepted.

---

## D-018

Date

2026-07-23

Decision

Verified WooCommerce `order.created`, `order.updated`, `order.deleted`, and
`order.restored` WebhookEvents project into a tenant/Store-scoped Order snapshot
identified uniquely by Store ID and WooCommerce order ID.

WooCommerce `date_modified_gmt` is the primary ordering field. Older projections
are no-ops; newer projections apply; equal timestamps with equal stable
fingerprints are no-ops; equal timestamps with different fingerprints require
one authoritative M6 single-order fetch. Missing or unreliable modification
timestamps and otherwise malformed snapshots with a stable order ID use that
same bounded reconciliation path.

WebhookEvent processing uses a 30-second database lease. `QUEUED` events and
expired `PROCESSING` leases may be claimed atomically; active leases do not
duplicate projection work. Retryable reconciliation failures return to
`QUEUED` for the existing three BullMQ attempts. Terminal or exhausted failures
remain `FAILED` with an M6-normalized category, bounded safe code, attempt count,
and failure timestamp.

WooCommerce core source verification established that `order.deleted` builds an
ID-only payload and `order.restored` builds the normal REST resource payload.
M9 therefore sets `remote_deleted_at` on an existing snapshot for verified
delete topics and clears it by re-projecting verified restore topics. A generic
M6 `not-found` reconciliation result remains terminal because it cannot safely
distinguish a missing order from a missing REST route.

Reason

Database uniqueness, source modification time, canonical fingerprints, and
bounded lease recovery provide deterministic at-least-once processing without a
new queue or distributed lock. Single-order reconciliation repairs uncertain
state without introducing full-store sweeps, polling, or historical imports.

Boundary

M9 synchronizes Orders only. It adds no Telegram behavior, WooCommerce writes,
product/customer/inventory/address domain models, bulk synchronization, replay
API/UI, scheduler, or metrics platform.

Status

Accepted.

---

## D-019

Date

2026-07-23

Decision

Telegram account linking uses one-time, short-lived, cryptographically random
tokens issued from the authenticated SaaS user surface. Only SHA-256 token
hashes are persisted. Redemption is atomic and binds one Telegram user to one
SaaS User plus one authorized private chat; groups, supergroups, and channels
cannot become authorized.

All Telegram identity persistence, token validation, membership lookup, and
tenant/Store context resolution remain in the NestJS backend. The standalone
grammY process is a stateless long-polling transport and presentation adapter
that never imports Prisma or opens a database connection.

Bot-only internal endpoints bypass the global JWT guard only to enforce a
dedicated `X-Bot-Api-Key` guard using the typed `BOT_INTERNAL_API_KEY`
configuration. Every bot request propagates `X-Correlation-Id` and
`X-Telegram-Update-Id`. Redeem and confirmed unlink operations are transactionally
idempotent by Telegram user and update ID.

Active context is selected automatically only when the linked User has exactly
one active Membership and that tenant has exactly one non-deleted `ACTIVE`
Store. Otherwise both active IDs remain null and selection is reported as
required. M10 adds no selection/switching command.

Unlink requires explicit private-chat confirmation and atomically soft-revokes
the TelegramAccount and all of its chat authorizations.

Reason

This boundary preserves tenant and membership authorization in the backend,
prevents possession of a chat ID from becoming authorization, keeps the bot
recoverable and free of local persistent state, and makes duplicated Telegram
updates and timeout-after-commit recovery safe.

Boundary

M10 includes `/start`, `/status`, and confirmed `/unlink` account-linking
behavior only. It adds no order management, Store switching, group support,
webhook transport, or other Telegram operational commands.

Status

Accepted.

---

Next decision number: D-020.
