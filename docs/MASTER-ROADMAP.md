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

M12 — Telegram Order Status Update (merged; awaiting real-store validation)

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

M12 is merged; the sole remaining gate before Phase 4 closure review is A's
validation against a real WooCommerce store.

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
