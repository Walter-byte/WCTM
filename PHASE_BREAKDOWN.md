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

### Task 2.2 — Authentication foundation 🟨 In Review

- Access-token-only JWT signing and verification through typed configuration
- Passport JWT bearer strategy and deny-by-default global authentication guard
- Explicit `@Public()` route opt-out and `@CurrentUser()` payload access
- Focused configuration, token, expiry, guard, and public-route tests

### Planned follow-up tasks

- Multi-tenancy
- Database schema evolution
- User, tenant, and store management
- Logging

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
