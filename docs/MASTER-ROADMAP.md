# MASTER ROADMAP

Project: WooCommerce Telegram SaaS
Version: 1.0
Status: Active

---

# PURPOSE

This document is the master implementation roadmap.

It defines every project phase, milestone, deliverable, and current progress.

Detailed implementation tasks are tracked in `PHASE_BREAKDOWN.md`.

Only A (Project Owner + Architect) may modify the roadmap.

B (Project Orchestrator) must follow it.

C implements only the current task.

---

# PROJECT PHASES

## Phase 0 — Foundation

Status:
☑ Complete

Deliverables

- Product idea validated
- SaaS vision defined
- Technology stack selected
- Production architecture selected
- Core documentation created
- AI workflow established

---

## Phase 1 — Project Initialization

Status:
✅ Complete

Deliverables

- Git repository
- Repository structure
- Docker development environment
- Backend bootstrap
- Plugin bootstrap
- Shared configuration
- CI basics
- Environment templates

Exit Criteria

✅ Met on 2026-07-20: project builds successfully on a clean machine.

---

## Phase 2 — Backend Core

Status:
✅ Complete

Deliverables

- Authentication foundation — Task 2.2 complete
- Multi-tenancy — M2 complete
- Database schema — complete
- User system — M3 complete
- Tenant management — M3 complete
- Store management — M4 complete
- Production operations foundation — M5 complete
- Application foundation and structured logging — M1 complete
- Configuration system — Task 2.1 complete

Exit Criteria

✅ Met on 2026-07-22: Backend API is operational.

---

## Phase 3 — WooCommerce Integration

Status:
✅ Complete

Deliverables

- REST client — M6 complete
- Webhook verification — M8 complete
- Plugin communication — M7 registration handshake complete
- Credential validation — M6 complete
- Store registration — M7 complete
- Order sync service — M9 complete

Exit Criteria

✅ Met on 2026-07-23: verified order webhooks project idempotently into
tenant/Store-scoped Order snapshots, with stale-event protection, recoverable
processing leases, and bounded single-order reconciliation.

---

## Phase 4 — Telegram Platform

Status:
✅ Complete

Final Milestone:

M16 Self-Service Store Onboarding — complete, reviewed, merged, deployed, and
live-validated

Deliverables

- Bot framework
- Manager registration
- Chat authorization
- Command system
- Inline keyboards
- Callback handling

M10 scope:

- Backend-owned Telegram identity and private-chat authorization
- One-time account-link token issue and redemption
- Bot-key-authenticated internal API
- `/start`, `/status`, and confirmed `/unlink`
- Automatic context only for exactly one eligible tenant and Store

M11 scope:

- Bot-only projected Order list and detail endpoints
- Read access for active OWNER, ADMIN, and MEMBER memberships
- Eight-row keyset pagination with a 200-row reachable cap
- Expiring HMAC-authenticated callback references bound to current context
- `/orders`, inline pagination, detail selection, and back navigation
- `Order.lastSyncedAt` freshness with configurable delayed signaling
- No WooCommerce calls, writes, direct `/order` lookup, or Store switching

M12 scope:

- OWNER/ADMIN status writes from the M11 private-chat detail view; MEMBER is
  read-only
- Server-derived WooCommerce core transition targets with live status
  revalidation
- Single-effect HMAC callback references and durable reference-plus-target
  idempotency
- One WooCommerce write dispatch, lost-response live reconciliation, and
  authoritative M9 projection updates
- Stateless grammY rendering/forwarding with no Prisma or database access

M12-V scope:

- Private-pilot-only `pilot:setup` and `pilot:readiness` workspace commands
- Explicit `PILOT_MODE` guard and refusal of unrelated existing bootstrap data
- Atomic first User, Tenant, and OWNER Membership provisioning
- In-memory `AuthService` access token issuance with no JWT operator handling
- Fail-closed encrypted Store connection and exactly one `ACTIVE` pilot Store
- Backend-owned webhook credentials plus WooCommerce-side required order
  webhook registration to an approved public Caddy HTTPS origin
- One-time Telegram `/start` handoff, manual synthetic-order creation, and nine
  bounded PASS/FAIL readiness checks
- No public onboarding, completed connector UI, billing, reset, force, or
  destructive teardown

M13 scope:

- Backend-owned recipient discovery, durable per-Order/private-chat delivery
  state, idempotency, deterministic `operations`-queue scheduling, sanitized
  content, existing M11/M12 actions, and bounded outcome persistence
- Current M10/M11 authorization/context revalidation before dispatch; no new
  RBAC or Store-selection policy
- Stateless grammY-only Telegram API transport through one private
  `BOT_INTERNAL_API_KEY`-authenticated prepared-message operation
- Delivered no-op, terminal no-retry, ambiguous no-blind-resend, and existing
  M5 bounded retries only for definitive transient no-delivery outcomes

M14 scope:

- Stateless Home, Recent Orders, Status, Help, and consistent Back navigation
  across the existing M10–M13 Telegram flows
- `/start`, `/status`, `/orders`, `/help`, and Telegram command-menu cleanup for
  existing functionality only
- Clear empty, expired, stale/context-changed, unauthorized, no-active-Store,
  transport-failure, and status-result recovery presentation
- Native M13 notification references continue through unchanged M11 detail and
  M12 status flows, with edit-to-reply fallback preserved
- No backend contract, authorization, callback-security, persistence, schema,
  order, notification-delivery, or status-write behavior change

M15 scope:

- Public register/login with normalized email identity, Argon2id passwords,
  endpoint-scoped Redis limiting, and the existing User-subject JWT format
- No Tenant, Membership, Store, refresh-token, email-verification, or password-
  reset behavior

M16 scope:

- Authenticated exact-one-Membership tenant-context JWT bridge with M3 as the
  sole first-Tenant/OWNER bootstrap
- Restrained same-origin onboarding ceremony for account, Tenant, Store, M7
  token, connector/health progress, and backend-gated M10 linking
- Production WordPress connector redemption, non-autoloaded secret storage,
  required M8 order-webhook installation/verification, safe retry, and new-token
  reconnect guidance
- Successful M7 redemption preserves the established `PENDING` → `ACTIVE`
  transition; authenticated connector health separately verifies the required
  remote WooCommerce webhook configuration without owning the Store lifecycle
- No onboarding-state model, dashboard, Store/Tenant switching, billing, or
  later management behavior

M16 completion evidence:

- WordPress connector 0.2.2 supports the direct connector HTTPS origin needed
  by restricted/Iran-hosted networks, corrects the proxied `WC_Data_Store`
  loader defect, safely reconciles duplicate canonical hooks, restores the
  persisted M8 secret, and keeps Retry idempotent
- A verified that exactly four current connector-owned order hooks remained
  after obsolete private-pilot hooks were removed; a real signed M8
  `order.created` delivery returned HTTP 200
- The stale pilot Telegram identity conflict was corrected; fresh M10 linking,
  `/status`, `/orders`, order detail, Back/Home, and replay rejection passed
- B returned MERGE; A live validation passed; merge commit `9e831a9` is on
  `main`, deployed to the VPS, and `/api/health` passed

M10 through M16 are complete and merged to `main`; D-023 remains Accepted. No
new architectural or product decision was required for Phase 4 closure.

Exit Criteria

✅ Met on 2026-08-30: the manager can control the Store from Telegram through
the implemented MVP order-management path.

---

## Phase 5 — Core Store Management (MVP)

Status:
✅ Complete

Completed milestones:

- M17 — Order Workflow Completion
- M18 — MVP Store Settings Foundation, fully operationally validated
- M19 — Inventory & Low-Stock MVP, fully operationally validated
- M20 — Search & Daily Report, fully complete, merged, deployed, hotfixed, and
  operationally validated
- M21 — Notification / Localization Completion, fully complete, merged,
  deployed, and operationally validated
- M22 — Basic MVP Entitlements & Phase 5 Closure, fully complete, merged,
  migrated, deployed, and operationally validated

Modules

Orders

Inventory

Customers

Payments

Reports

Notifications

Exit Criteria

✅ Met on 2026-09-04: all approved MVP Telegram product features are
implemented and bounded production pilot validation has passed. This phase
closure does not complete Phase 6 commercial SaaS work, Phase 7 production-
readiness work, or authorize unrestricted public launch.

---

## Phase 7 — Production Readiness

Status:
🔵 Current phase — next after Phase 5, by explicit A decision D-029

Phase 7 executes before Phase 6. It is production hardening and readiness only;
it does not include pricing, billing, subscriptions, plan differentiation,
usage limits, advanced WooCommerce features, dashboard expansion, or other
commercial/product expansion.

Milestones, in order:

- P7.1 — Production Security Baseline
- P7.2 — Production Migration & Deployment Path
- P7.3 — Backup, Restore & Disaster Recovery
- P7.4 — Monitoring & Alerting
- P7.5 — Data & Time Correctness
- P7.6 — Network & Runtime Reliability
- P7.7 — Audit & Operational Integrity
- P7.8 — Final Launch Readiness Gate

No Phase 7 milestone has started. P7.1 is the next implementation milestone.

---

## Phase 6 — SaaS Platform

Status:
⬜ Deferred / unstarted until Phase 7 completes and A separately authorizes it

Deliverables

Subscriptions

Plans

Billing

Dashboard

Tenant administration

Usage limits

---

## Phase 8 — Public Launch

Iran

Collect feedback

Improve onboarding

Fix UX

---

## Phase 9 — Global Expansion

Localization

Multiple currencies

Multiple languages

International payment gateways

Marketplace integrations

---

# RULES

Only one implementation task at a time.

No skipping phases.

No hidden work.

No feature creep.

No architecture changes without approval.

Every completed task updates:

PROJECT_STATE.md

DECISIONS.md (if needed)

Git commit

Documentation

---

# SUCCESS CRITERIA

Simple

Reliable

Secure

Maintainable

Production-ready

Human-friendly

Scalable
