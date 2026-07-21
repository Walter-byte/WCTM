# PROJECT STATE

Version: 1.0

---

Current Phase

Phase 2 — Backend Core in progress.

---

Current Task

None assigned. M3 has not started.

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

---

Plugin

WooCommerce connector scaffold created.

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

---

Technical Debt

AuditLog immutability enforcement is deferred to a future approved task.

---

Current Blockers

None

---

Next Milestone

Await the next approved milestone. M3 has not started.

---

Last Completed

M2 — Multi-Tenant Core, merged into main in commit `80ac3ee`.

---

Project Health

Excellent

---

Last Updated

2026-07-21
