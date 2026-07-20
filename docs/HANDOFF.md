# Project Handoff Document
**Generated:**2026-07-19
**Reason:** Transitioning implementation agent from GapCode to Codex GPT  
**Project:** WC-Telegram-SaaS  
**Prepared by:** Walter (Salar / walterbyte)

---

## 1. Project Overview

A production SaaS platform that allows WooCommerce store owners to manage their
stores entirely through Telegram. Telegram is the **primary management interface**,
not just an alert channel.

**Target market (initial):** Iran
**Architecture pattern:** Multi-tenant SaaS, simplicity-first (D-010)

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Backend API | NestJS (Fastify adapter considered, Express default) |
| Database | PostgreSQL |
| ORM / Migrations | Prisma 7 (Prisma Migrate) |
| Queue / Jobs | BullMQ |
| Cache / Sessions / Rate-limit | Redis |
| Telegram Bot | grammY |
| WooCommerce | REST API + Webhooks |
| WordPress Plugin | Lightweight connector (auth, registration, webhook mgmt) |
| Containerization | Docker / Docker Compose |
| Reverse Proxy | Caddy |
| Language | TypeScript (strict) |

n8n is **NOT** part of the production architecture (D-008, prototype only).

---

## 3. Architectural Decisions (D-001–D-012)

| ID | Decision | Status |
|---|---|---|
| D-001 | Develop as production SaaS | Accepted |
| D-002 | NestJS for backend (alt: Fastify standalone) | Accepted |
| D-003 | PostgreSQL as database | Accepted |
| D-004 | Redis mandatory (cache, queues, sessions, rate-limiting) | Accepted |
| D-005 | BullMQ for async jobs | Accepted |
| D-006 | WooCommerce via REST API + Webhooks | Accepted |
| D-007 | Telegram is primary management UI | Accepted |
| D-008 | n8n excluded from production | Accepted |
| D-009 | WordPress plugin stays lightweight | Accepted |
| D-010 | Simplicity-first; no overengineering, no premature optimization | Accepted |
| D-011 | Prisma ORM + Prisma Migrate; `schema.prisma` is single source of truth; all models have `created_at`/`updated_at`; soft-delete on Tenant, Store, Membership | Accepted |
| D-012 | PrismaService uses Prisma's official PostgreSQL driver adapter | Accepted |

Next decision number: **D-013**, if Task 1.4 produces a genuine architectural or
product decision.

---

## 4. Completed Tasks

### Phase 0 — Foundation (100% complete)
- Product idea validated
- SaaS vision defined
- Technology stack selected
- Production architecture designed
- Core documentation created (`PROJECT-TELEGRAM-WC-SAAS.md`, `MASTER-ROADMAP.md`,
  `PROJECT_STATE.md`, `DECISIONS.md`, `AI_OPERATING_MANUAL.md`)
- AI workflow established

### Phase 1 — Project Initialization (Tasks 1.1–1.3 complete)

#### Task 1.1 — Repository & Docker Scaffold
- Monorepo structure initialized
- `docker-compose.yml` created with `backend` and `postgres` services
- Multi-stage `Dockerfile` created for the backend
- Container `WORKDIR` set to `/app/backend`
- Environment template (`.env.example`) created
- Base `package.json` for the backend workspace

#### Task 1.2 — Prisma Integration & Core Schema

**Prisma schema location:** `backend/prisma/schema.prisma`

**Models (6 total):**
- `Tenant` — organization/account; has `plan` (TenantPlan enum), soft-delete (`deleted_at`)
- `User` — global user model; linked to tenants via Membership
- `Membership` — links User↔ Tenant with RBAC `role`; soft-delete
- `Store` — WooCommerce store owned by a Tenant; has `status` (StoreStatus enum),
  encrypted credential fields (`consumer_key_encrypted`, `consumer_secret_encrypted`,
  `webhook_secret_encrypted`), soft-delete
- `WebhookEvent` — inbound events with `dedupe_key` for idempotency
- `AuditLog` — audit records; structural immutability is not yet enforced because
  the model includes an updatable timestamp. This is a known limitation and a
  candidate decision for A, not a Task 1.4 schema change.

**Enums (2 total):**
- `TenantPlan`: future billing tiers (no billing logic yet)
- `StoreStatus`: store health/connection state

**Schema conventions enforced:**
- `snake_case` table/column names via `@map` / `@@map`
- Prefixed string IDs
- `created_at` / `updated_at` on every model
- Soft-delete (`deleted_at`) on Tenant, Store, Membership
- Every foreign key is indexed by default
- Credentials stored as separate encrypted fields (not a generic blob)

**Migration:** `init_schema` migration generated and verified.
**Commands verified:** `prisma validate`✓ | `prisma format --check` ✓ | `prisma generate` ✓

**`backend/package.json`** includes:
```json
"prisma": {
  "schema": "prisma/schema.prisma"
}
```

**Important:** `DATABASE_URL` points to `postgres:5432` (Docker Compose service name),
only resolvable inside the Docker network. Run migrations via:

```bash
docker compose exec backend npx --no-install prisma migrate deploy
```

Task 1.4 must verify that the production backend image contains the Prisma CLI.
If this command fails because the CLI is absent, A must approve the remediation.

#### Task 1.3 — NestJS Prisma Module Integration

**Files created/modified:**
- `backend/src/prisma/prisma.module.ts` — `@Global()` module, exports `PrismaService`
- `backend/src/prisma/prisma.service.ts` — extends `PrismaClient`, implements
  `OnModuleInit` (`$connect()`) and `OnModuleDestroy` (`$disconnect()`)
- `backend/src/main.ts` — `app.enableShutdownHooks()` added for graceful SIGTERM

**Behavior:**
- PrismaService connects on application startup
- PrismaService disconnects cleanly on SIGTERM
- Any NestJS module can inject `PrismaService` without re-importing `PrismaModule`
- No repositories, domain services, or extra abstractions added

**Quality gates passed:**
- TypeScript typecheck ✓
- ESLint ✓
- Prettier ✓
- Build✓
- `prisma generate` ✓
- `prisma validate` ✓

---

## 5. Current Repository Structure

Core documents are under `docs/`. The current scaffold uses `backend/` for the
NestJS API, `telegram-bot/` for the grammY process, and `wp-content/plugins/` for
the lightweight connector. The larger `apps/`, `packages/`, and
`infrastructure/` layout remains a planned target rather than current structure.

---

## 6. Current Blockers

- The `init_schema` Prisma migration has been **generated but not yet applied**
  to the database. The PostgreSQL port is not exposed externally.
  To apply during Task 1.4 verification:
  `docker compose exec backend npx --no-install prisma migrate deploy`

---

## 7. Next Tasks (Phase 1 remaining / Phase 2 start)

The immediate next task is likely one of:
- Complete Phase 1 exit criterion: verify the project builds on a clean machine
- Begin Phase 2: Backend Core- Authentication module
  - Multi-tenancy middleware/guards
  - Tenant management service
  - User system
  - Store management service
  - Logging (structured)
  - Configuration system (`@nestjs/config` + validation)

**Do not begin Phase 2 until Phase 1 exit criterion is confirmed.**

---

## 8. AI Operating Rules (Must Follow)

Roles:
- **A** — Project owner, architect, final decision maker (Walter)
- **B** — Orchestrator (context, prompts, review, state updates) — currently this document
- **C** — Implementation agent (you, Codex GPT)

Process (strictly sequential):
1. Read all project files
2. Understand current state
3. Implement one task at a time
4. Wait for review/approval before the next task
5. Update `PROJECT_STATE.md` and `DECISIONS.md` (when needed) after each task
6. Commit with a descriptive message

**Hard rules:**
- One task at a time — no skipping, no bundling
- No feature creep
- No architecture changes without explicit approval
- No hidden work
- No new dependencies without justification
- Every completed task must include: updated `PROJECT_STATE.md`, Git commit,
  and `DECISIONS.md` entry if a new decision was made

---

## 9. Multi-Tenancy & Security Requirements (Non-Negotiable)

- Every DB query must be tenant-scoped — never rely solely on `user_id` or `order_id`
- Queue jobs must carry and validate `tenant_id` and `store_id`
- Telegram callbacks must resolve to the correct tenant and authorized user
- Authorization is based on Membership role, not just possession of a chat ID
- Tenant A must never read or affect Tenant B data
- Credentials (WooCommerce keys, webhook secrets, bot tokens) must be encrypted at rest
- No secrets in commits, logs, telemetry, or Telegram messages
- Webhook events must be idempotent (use `dedupe_key`)
- All state-changing actions must produce an AuditLog record

---

## 10. Production Flow (Reference)


WooCommerce Store→ WordPress connector plugin (lightweight)
  → Authenticated webhook/event delivery
  → NestJS API (webhook ingress + HTTP API)
  → Redis-backed BullMQ queue
  → Workers (event processing, WC calls, Telegram delivery, reports, retries)
  → Telegram Bot API (grammY)
  → PostgreSQL (tenant data, state, audit)
  → Redis (queues, cache, rate limits, transient conversation state)

---

*End of handoff document.*
