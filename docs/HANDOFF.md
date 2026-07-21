# Project Handoff Document

**Generated:** 2026-07-19

**Updated:** 2026-07-22

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

| Layer                         | Technology                                               |
| ----------------------------- | -------------------------------------------------------- |
| Backend API                   | NestJS (Fastify adapter considered, Express default)     |
| Database                      | PostgreSQL                                               |
| ORM / Migrations              | Prisma 7 (Prisma Migrate)                                |
| Queue / Jobs                  | BullMQ                                                   |
| Cache / Sessions / Rate-limit | Redis                                                    |
| Telegram Bot                  | grammY                                                   |
| WooCommerce                   | REST API + Webhooks                                      |
| WordPress Plugin              | Lightweight connector (auth, registration, webhook mgmt) |
| Containerization              | Docker / Docker Compose                                  |
| Reverse Proxy                 | Caddy                                                    |
| Language                      | TypeScript (strict)                                      |

n8n is **NOT** part of the production architecture (D-008, prototype only).

---

## 3. Architectural Decisions (D-001–D-014)

| ID    | Decision                                                                                                                                                    | Status   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D-001 | Develop as production SaaS                                                                                                                                  | Accepted |
| D-002 | NestJS for backend (alt: Fastify standalone)                                                                                                                | Accepted |
| D-003 | PostgreSQL as database                                                                                                                                      | Accepted |
| D-004 | Redis mandatory (cache, queues, sessions, rate-limiting)                                                                                                    | Accepted |
| D-005 | BullMQ for async jobs                                                                                                                                       | Accepted |
| D-006 | WooCommerce via REST API + Webhooks                                                                                                                         | Accepted |
| D-007 | Telegram is primary management UI                                                                                                                           | Accepted |
| D-008 | n8n excluded from production                                                                                                                                | Accepted |
| D-009 | WordPress plugin stays lightweight                                                                                                                          | Accepted |
| D-010 | Simplicity-first; no overengineering, no premature optimization                                                                                             | Accepted |
| D-011 | Prisma ORM + Prisma Migrate; `schema.prisma` is single source of truth; all models have `created_at`/`updated_at`; soft-delete on Tenant, Store, Membership | Accepted |
| D-012 | PrismaService uses Prisma's official PostgreSQL driver adapter                                                                                              | Accepted |
| D-013 | Global typed configuration uses `@nestjs/config` with Joi validation                                                                                        | Accepted |
| D-014 | One in-process BullMQ operations worker with three exponential-backoff attempts                                                                             | Accepted |

Next decision number: **D-015**, if a future task produces a genuine
architectural or product decision.

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

### Phase 1 — Project Initialization (Tasks 1.1–1.4 complete)

#### Task 1.1 — Repository & Docker Scaffold

- Monorepo structure initialized
- `docker-compose.yml` created with backend, PostgreSQL, Redis, Telegram bot,
  and Caddy services
- Multi-stage `Dockerfile` created for the backend
- Container `WORKDIR` set to `/app/backend`
- Environment template (`.env.example`) created
- Compose network names are project-scoped to prevent cross-project collisions
- Application encryption configuration uses `APP_ENCRYPTION_KEY`
- Base `package.json` for the backend workspace

#### Task 1.2 — Prisma Integration & Core Schema

**Prisma schema location:** `backend/prisma/schema.prisma`

**Models (6 total):**

- `Tenant` — organization/account; has `plan` (TenantPlan enum), soft-delete (`deleted_at`)
- `User` — global user model; linked to tenants via Membership
- `Membership` — links User↔ Tenant with `MembershipRole`; soft-delete
- `Store` — WooCommerce store owned by a Tenant; has `status` (StoreStatus enum),
  encrypted credential fields (`consumer_key_encrypted`, `consumer_secret_encrypted`,
  `webhook_secret_encrypted`), soft-delete
- `WebhookEvent` — inbound events with `dedupe_key` for idempotency
- `AuditLog` — audit records; structural immutability is not yet enforced because
  the model includes an updatable timestamp. This is a known limitation and a
  candidate decision for A, not a Task 1.4 schema change.

**Enums (3 total):**

- `TenantPlan`: future billing tiers (no billing logic yet)
- `StoreStatus`: store health/connection state
- `MembershipRole`: minimal tenant roles (`OWNER`, `ADMIN`, `MEMBER`)

**Schema conventions enforced:**

- `snake_case` table/column names via `@map` / `@@map`
- Prefixed string IDs
- `created_at` / `updated_at` on every model
- Soft-delete (`deleted_at`) on Tenant, Store, Membership
- Every foreign key is indexed by default
- Credentials stored as separate encrypted fields (not a generic blob)

**Migration:** `init_schema` migration generated, deployed in the clean-clone
environment, and verified in sync.
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

The production backend image currently omits the Prisma CLI because Prisma is a
development dependency excluded by its production install. M3 migration
verification used the Docker builder stage inside the Compose network. The
runtime migration execution path requires a future approved infrastructure fix.

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

#### Task 1.4 — Clean-Environment Verification and Phase 1 Closure

- A clean clone installed dependencies and built successfully
- PostgreSQL and Redis health checks passed
- `init_schema` deployed and Prisma reported the database in sync
- Backend health and Caddy root endpoints passed
- Telegram bot offline scaffold started safely
- Graceful shutdown and full `docker compose down -v` teardown passed
- Fixed Compose network isolation and standardized `APP_ENCRYPTION_KEY`
- Added one offline NestJS boot smoke test and a basic Node 20 CI workflow
- Generated repository trees are intentionally excluded via `.gitignore`

### Phase 2 — Backend Core (complete)

#### Task 2.1 — Configuration Foundation (complete)

- `backend/src/config/application-config.module.ts` provides global validated
  configuration
- Application consumers inject `ApplicationConfigService` and use typed
  namespaces instead of reading `process.env`
- Namespaces cover application settings, PostgreSQL, Redis, JWT, application
  encryption, Telegram, and WooCommerce webhook settings
- Joi validation aggregates all failures before throwing a secret-safe startup
  error
- Test mode supplies isolated placeholders; production requires all application
  values and rejects documented development placeholders
- Configuration and secret namespaces mask sensitive values during JSON/string
  serialization and Node inspection
- Task 2.1 was merged into `main` in commit `19cb0d3`, containing implementation
  commit `2a39455`

#### Task 2.2 — Authentication Foundation (complete)

- The existing JWT configuration namespace now exposes the required
  `JWT_ACCESS_TTL` value as `accessTokenTtl`
- `AuthService` signs and verifies access tokens using only typed JWT settings
- Passport validates bearer tokens through `JwtStrategy`
- `JwtAuthGuard` protects routes globally; handlers or controllers must use
  `@Public()` for an explicit unauthenticated opt-out
- `@CurrentUser()` exposes the validated JWT payload to route handlers
- The health endpoint is public so container and operator health checks continue
  to work
- This foundation intentionally excludes user persistence, credential login,
  refresh tokens, RBAC, and tenant authorization
- Task 2.2 was merged into `main` in commit `9a9bbd4`

#### M1 — Database & Application Foundation (complete)

- `backend/src/common/logging/` provides the global structured JSON logger and
  request logging interceptor; `LOG_LEVEL` comes from
  `ApplicationConfigService`
- `backend/src/common/request-context/` uses AsyncLocalStorage to preserve an
  inbound `x-request-id` or generate a UUID, echo it on the response, and attach
  it to request logs
- `backend/src/common/filters/` normalizes HTTP and unknown exceptions as
  `{ statusCode, error, message, requestId }` without exposing unknown internals
- `backend/src/common/utils/` is reserved for shared utilities used by common
  infrastructure; M1 adds only secret-safe redaction and serialization support
- Jest covers the new common infrastructure while the existing Node smoke,
  configuration, and authentication tests remain part of the full suite
- M1 introduces no schema, tenant, RBAC, user, WooCommerce, audit, or job logic
- M1 was merged into `main` in commit `2dcade7`

#### M2 — Multi-Tenant Core (complete)

- `TenantContextService` exposes the active authenticated `tenantId`, `userId`,
  and membership role and fails closed when tenant context is unavailable
- Tenant data extends M1's existing request AsyncLocalStorage context; M2 does
  not introduce a second request-lifecycle store
- The global `TenantContextGuard` runs after JWT authentication, resolves an
  active Membership using signed `sub` and `tenantId` claims, and rejects absent
  or unauthorized membership with 403
- Explicit `@Public()` routes bypass tenant resolution; `@RequireMembership()`
  optionally restricts a route to listed membership roles without introducing
  an RBAC permission matrix
- `TenantScopedPrismaService` demonstrates tenant-owned Store reads and writes;
  it sources `tenantId` only from TenantContext and injects it into every query
- Isolation tests prove Tenant A cannot read or mutate Tenant B's Store row
- M2 adds no schema migration, tenant CRUD, user management, store endpoint,
  integration, billing, or job logic
- M2 was merged into `main` in commit `80ac3ee`

#### M3 — User & Tenant Management (complete)

- `UsersModule` exposes JWT-protected, tenant-optional own-profile read and
  display-name update endpoints backed by persisted User records
- `TenantsModule` creates a tenant and its creator's OWNER membership atomically;
  current-tenant read, name update, and soft deletion use server tenant context
- `MembershipsModule` adds existing users, lists active memberships, changes
  roles, and soft-deletes memberships within the active tenant only
- `MembershipRole` replaces the free-form role string with `OWNER`, `ADMIN`, and
  `MEMBER`; migration `20260721160000_membership_role_enum` is applied and in
  sync in the local verification database
- OWNER and ADMIN may manage non-owner memberships; only OWNER may grant or
  manage OWNER, and the final active OWNER cannot be removed or demoted
- `@TenantOptional()` bypasses tenant resolution only for JWT-authenticated own
  profile and tenant-bootstrap routes; it does not bypass authentication
- Joi request pipes validate DTOs without adding dependencies, and tests cover
  lifecycle behavior, role enforcement, cross-tenant denial, and soft deletes
- M3 adds no authentication flow, advanced RBAC, store CRUD, integration,
  billing, background-job, or audit tooling
- M3 was merged into `main` in commit `c042b5b`

#### M4 — WooCommerce Store Management (complete)

- `EncryptionModule` exports `EncryptionService`, whose `encrypt()` and
  `decrypt()` methods use AES-256-GCM with the typed
  `ApplicationConfigService.encryption.key`; stored values use base64
  `iv:authTag:ciphertext` components
- `WooCommerceClient` is instantiated per connection test with decrypted
  in-memory credentials and exposes
  `testConnection(): Promise<{ success, storeName?, error? }>`
- `StoreModule` registers tenant-scoped `/stores` create, list, read, update,
  soft-delete, and `/:id/test-connection` routes
- `TenantScopedPrismaService` injects the active server-side tenant into every
  Store query; missing, deleted, and cross-tenant records return 404 without
  confirming ownership
- Store API responses use credential-free Prisma selections. Raw and encrypted
  consumer credentials are never returned or logged; decrypted values exist
  only while constructing the per-request WooCommerce client
- OWNER and ADMIN memberships may create, update, and delete stores; MEMBER may
  read stores and run a connection test
- M4 adds only the required direct `axios` runtime dependency for the approved
  WooCommerce REST client; the existing Store schema requires no migration
- Eleven focused M4 tests cover encryption, CRUD, soft deletion, connection
  results, cross-tenant isolation, and MEMBER mutation denial
- M4 was merged into `main` in commit `2da985b`

#### M5 — Production Operations Foundation (complete)

- `AuditModule` exports `AuditService.record()` for action, entity, entity ID,
  and metadata input; tenant and actor IDs come only from `TenantContextService`
- Membership create/reactivate, role update, and removal plus Store create,
  update, soft-delete, and connection tests emit append-only AuditLog records
- Audit metadata accepts only approved roles, Store statuses, safe changed-field
  names, credential-change booleans, and connection success; raw secrets,
  tokens, passwords, keys, URLs, and payloads are not persisted
- `QueueModule` owns one BullMQ `operations` queue, one reference producer, and
  one in-process worker using exact-pinned BullMQ `5.80.10`
- Producers source tenant identity from server context. Processors reject
  missing or malformed `tenantId` and validate optional `storeId`
- Reference jobs use three total attempts with exponential backoff starting at
  one second. Exhausted jobs remain failed in BullMQ and emit a structured error
  without logging exception text or payload contents
- `GET /api/health` remains the public liveness endpoint;
  `GET /api/health/readiness` returns 200 only when PostgreSQL and Redis respond
- Nest shutdown hooks wait for active worker work, then close worker and queue
  connections on SIGTERM/SIGINT
- The existing AuditLog and Store schemas were sufficient; M5 has no migration
- M5 was merged into `main` in commit `0cdf0e6`

Operational runbook:

1. Start the backend with PostgreSQL and Redis available; the operations worker
   starts inside the backend process outside `NODE_ENV=test`.
2. Probe `/api/health` for process liveness and `/api/health/readiness` before
   routing traffic. A readiness 503 means PostgreSQL or Redis is unavailable.
3. Inspect structured backend logs for
   `Background job exhausted retry attempts`; use the logged queue, job ID,
   tenant ID, optional Store ID, and attempt count for diagnosis. Secrets and
   raw errors are intentionally absent.
4. Send SIGTERM/SIGINT or use `docker compose stop backend` for graceful worker
   and queue connection shutdown. Do not force-kill during active work unless
   recovery procedures require it.

---

## 5. Current Repository Structure

Core documents are under `docs/`. The current scaffold uses `backend/` for the
NestJS API, `telegram-bot/` for the grammY process, and `wp-content/plugins/` for
the lightweight connector. The larger `apps/`, `packages/`, and
`infrastructure/` layout remains a planned target rather than current structure.

---

## 6. Current Blockers

None. The initial migration is applied and the clean-environment verification is
complete.

---

## 7. Current Task

No milestone is currently assigned. M5 — Production Operations Foundation is
complete and merged into `main`. Phase 2 is complete, and Phase 3 has not
started.

**Do not begin Phase 3 without explicit approval from A.**

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

_End of handoff document._
