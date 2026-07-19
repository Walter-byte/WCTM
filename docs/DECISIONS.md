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

Future decisions continue below.
