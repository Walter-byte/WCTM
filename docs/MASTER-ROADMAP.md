# MASTER ROADMAP

Project: WooCommerce Telegram SaaS
Version: 1.0
Status: Active

---

# PURPOSE

This document is the master implementation roadmap.

It defines every project phase, milestone, deliverable, and current progress.

Detailed implementation tasks are tracked in `../PHASE_BREAKDOWN.md`.

Only A (Project Owner + Architect) may modify the roadmap.

B (Project Orchestrator) must follow it.

C (GapCode) implements only the current task.

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
🚧 In Progress

Current Milestone:

M14 Practical Telegram Management UX (implemented; awaiting review and manual
validation)

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

M12, M12-V, and M13 are complete and merged to `main`; D-023 is Accepted. M14
is implemented on `feat/m14-telegram-management-ux` with automated gates
passing and awaits A/B review plus one bounded manual Telegram UX validation.
Phase 4 remains In Progress. No later product milestone is assigned.

Next operator action:

- Review M14 and run the bounded manual Telegram navigation checklist
- Retain the pending M13 deployment checks: apply migration
  `20260820090000_order_event_notifications`, configure the private bot
  transport, and validate one synthetic notification delivery without repeated
  real-store testing

Exit Criteria

Manager controls store from Telegram.

---

## Phase 5 — Core Store Management (MVP)

Status:
⬜ Pending

Modules

Orders

Inventory

Customers

Payments

Reports

Notifications

Exit Criteria

MVP is production-ready.

---

## Phase 6 — SaaS Platform

Status:
⬜ Pending

Deliverables

Subscriptions

Plans

Billing

Dashboard

Tenant administration

Usage limits

---

## Phase 7 — Production Readiness

Status:
⬜ Pending

Deliverables

Security audit

Performance

Monitoring

Backups

Documentation

Testing

Deployment

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
