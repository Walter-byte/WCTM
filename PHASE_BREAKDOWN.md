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

## Phase 3 — WooCommerce Integration 🟨 Active

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

Phase 3 remains active. No next milestone is assigned.

## Phase 4 — Telegram Platform ⬜ Planned

- Manager registration, chat authorization, commands, inline keyboards, and
  callback handling

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
