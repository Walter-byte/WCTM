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

Future decisions continue below.
