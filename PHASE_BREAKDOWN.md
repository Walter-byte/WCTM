# Phase Breakdown

This document expands the approved phases in `docs/MASTER-ROADMAP.md` into
implementation tasks. Phase 2 work proceeds one approved task at a time; later
phases remain planned.

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

## Phase 2 — Backend Core 🟨 In Progress

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

### M4 — WooCommerce Store Management 🟨 Awaiting Review

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

### Planned follow-up tasks

- No later milestone is currently assigned.

## Phase 3 — WooCommerce Integration ⬜ Planned

- REST client, webhook verification, plugin communication, credential validation,
  store registration, and synchronization

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
