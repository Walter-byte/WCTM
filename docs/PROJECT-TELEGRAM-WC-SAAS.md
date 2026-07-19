# WooCommerce Telegram Manager SaaS — Permanent Project Memory

> **Purpose:** This is the long-term product and technical source of truth for AI assistants and contributors working on this project. Read it before proposing architecture, writing code, changing scope, or making product decisions. When a decision changes, update the Decision Log rather than silently contradicting this document.

## 1. Project Identity

**Working name:** WooCommerce Telegram Manager (name may change before launch)

**One-line description:** A multi-tenant SaaS that lets WooCommerce store teams operate key daily store workflows from Telegram, without needing to open the WordPress/WooCommerce admin for routine work.

**Product principle:** Telegram is the operational interface, not merely a notification channel.

## 2. Vision and Goals

### Vision

Make Telegram a practical, secure operational workspace for WooCommerce stores: receive timely information, inspect store data, and complete approved actions in chat.

### Business goals

- Launch first for Iranian WooCommerce stores.
- Validate a paid MVP with real stores and real order operations.
- Expand internationally after product reliability, localization, onboarding, and billing are ready.
- Serve individual merchants, store managers, fulfillment teams, and agencies.

### Product goals

- Reduce routine trips to the WordPress dashboard.
- Make order handling faster on mobile.
- Provide actionable, reliable notifications instead of notification noise.
- Keep every automated or manager-initiated action traceable.
- Support multiple stores safely from one SaaS platform.

### Non-goals for MVP

- Replacing all WooCommerce/WordPress administration.
- Building a general-purpose workflow automation platform.
- Building an ERP, accounting system, or full customer-support suite.
- Running n8n as the production application core.

## 3. Market and Users

### Market sequence

1. **Iran:** Persian-first UX, RTL content, Iranian store workflows, local currency/date conventions where applicable.
2. **Global:** English-first expansion, then additional languages, currencies, timezones, and integrations.

### Primary users

- Store owner
- Store manager / operations manager
- Fulfillment or warehouse staff
- Customer-service agent
- Agency administrator managing multiple stores

### Core value proposition

Instead of using WordPress → WooCommerce → dashboard for everyday operations, a store team can use Telegram to receive events, view relevant context, and take permitted actions. The product sells **store operations in Telegram**, not just WooCommerce notifications.

## 4. Scope and Finalized Feature Catalogue

Features are organized by capability. Availability is governed by the MVP definition, plan limits, and roadmap—not every listed feature belongs in the first release.

### Orders

- New-order alerts with items, totals, customer, payment, and shipping summary
- Order lookup, search, pending-order list, and today's orders
- View full order detail, shipping address, customer details, and order notes
- Permitted status changes: pending payment, on-hold, processing, completed, cancelled, refunded, failed
- Add an order note; distinguish internal and customer-visible notes where WooCommerce supports it
- Approval/cancellation flows appropriate to store policy
- Payment, COD, high-value-order, and awaiting-payment reminders
- Refund-request review and refund workflow where a payment gateway/WooCommerce supports it
- Shipping tracking link and delivery-related status notifications
- Future: invoice/label generation, map links, customer contact shortcuts, partial fulfillment

### Inventory and products

- Low-stock and out-of-stock alerts with configurable thresholds
- Back-in-stock notification
- Product search and product inventory summary
- Quick, permission-controlled stock adjustment
- Daily inventory/low-stock report
- Future: product publish/update workflows and supplier-oriented replenishment tasks

### Customers

- New-customer and first-order alerts
- Returning/VIP customer signals and purchase history
- Customer search and basic customer detail
- Inactive-customer/win-back triggers (only when configured and compliant)
- Customer lifetime value and segmentation are future/reporting features

### Payments and refunds

- Payment received and payment failed notifications
- Payment failure reason when safely provided by the payment source
- Refund requested, approved, rejected, and processed notifications
- Chargeback/dispute integration is future and gateway-dependent

### Reviews

- New review notifications
- Review moderation actions: approve, reject/spam, reply where WooCommerce permissions and APIs allow

### Marketing and retention

- Coupon created, expired, and usage-limit alerts
- Configurable abandoned-cart and win-back campaigns (future/Pro; requires a valid data source and consent-aware implementation)
- Scheduled promotions and coupon broadcasts (future; must include audience controls and anti-spam safeguards)

### Reports

- Daily, weekly, and monthly sales summaries
- Revenue, order count, average order value, and best sellers
- Configurable report schedule and store timezone
- Future: conversion metrics, store-health scoring, richer analytics dashboard

## 5. Telegram Experiences

### Manager bot (core product)

The manager bot is private and role-aware. It uses concise, localized order cards and inline keyboards for safe actions.

Representative commands:

```text
/orders                 List actionable/pending orders
/order <number>         Open an order
/search <query>         Search orders, products, or customers as supported
/stock                  Show low-stock items
/report                 Show a report for the relevant period
/refunds                List pending refund work
/settings               Open safe, role-appropriate settings
/help                   Explain supported commands
```

Representative inline actions:

- View details / refresh
- Change status (only valid transitions)
- Approve, cancel, complete, hold, or refund (only with authorization and confirmation)
- Add note
- View customer/shipping information
- Open tracking/invoice links when configured

### Conversation rules

- Use callback payloads that are signed or otherwise tamper-resistant and short-lived when appropriate.
- Confirm consequential actions (refund, cancel, stock change, etc.) before execution.
- Re-fetch or verify current WooCommerce state before applying a state-changing action.
- Make actions idempotent; Telegram callbacks may be retried or duplicated.
- Respond with a clear success/failure message and an audit reference where useful.
- Avoid exposing secrets, unnecessary personal data, or payment data in chat.

### Optional customer bot (Pro/future)

The customer-facing bot is a separate capability and may use a separate bot identity. It can provide:

- Order tracking and proactive status updates
- Tracking links and delivery confirmation
- Order-status lookup through a verified flow
- FAQ, support-ticket initiation, and live-agent handoff
- Consent-aware coupons, reminders, reorder prompts, and recommendations

It must not reveal order information based solely on a guessable order number. Customer identity/order access must be verified.

## 6. Production Architecture

### Required production shape

```text
WooCommerce Store
  └─ Lightweight WordPress connector plugin
       └─ Authenticated webhook/event delivery
            └─ API gateway / application API
                 └─ Redis-backed job queue (BullMQ)
                      └─ Worker(s): event processing, WooCommerce calls, Telegram delivery
                           ├─ Telegram Bot API (grammY or Telegraf)
                           ├─ PostgreSQL (tenant data, state, audit records)
                           └─ Redis (queues, cache, rate limits, transient conversation state)

Docker deployment behind Caddy; monitoring, backups, and error reporting surround all services.
```

### Recommended stack

| Concern | Choice |
| --- | --- |
| Backend | NestJS preferred; Fastify is an acceptable alternative when chosen deliberately |
| Database | PostgreSQL |
| Cache / transient state | Redis |
| Queue / workers | BullMQ backed by Redis |
| Telegram | grammY preferred or Telegraf |
| WooCommerce integration | WooCommerce REST API plus webhooks; connector plugin for reliable integration/onboarding |
| Deployment | Docker / Docker Compose initially, Caddy reverse proxy |
| Observability | Structured logs, error tracking (e.g. Sentry), health checks; Prometheus/Grafana later |

### Architectural rules

1. **Do not use n8n as the production SaaS core.** n8n is allowed only for prototyping, migration experiments, or internal non-critical automations.
2. The API must enqueue slow or retryable work; webhook handlers must return quickly after authenticating and persisting/enqueuing the event.
3. Workers own event processing, external WooCommerce requests, Telegram delivery, scheduled reports, and retry handling.
4. Treat all external deliveries as at-least-once. Use idempotency keys, deduplication, and durable event/action records.
5. Tenant context is mandatory for every request, job, query, log record, metric, and authorization decision.
6. Do not trust event payloads alone for sensitive state transitions; verify against WooCommerce when needed.
7. Keep product-domain logic separate from transport layers (HTTP, Telegram, queue implementations).
8. Prefer versioned APIs, explicit schemas, database migrations, and typed contracts.

## 7. Multi-Tenant Model

One platform serves many independent WooCommerce stores. A tenant normally represents an organization/account; it may own one or more stores according to its plan.

### Tenant data (minimum)

- Tenant/organization ID, plan, status, locale, timezone, and billing metadata
- Store ID, WooCommerce base URL, encrypted credentials, webhook secret/configuration, health status
- Telegram bot configuration and registered manager chat/user IDs
- Users/memberships, roles, and store-level permissions
- Notification preferences, thresholds, templates, rate limits, and report schedules
- Integration settings and encrypted secrets
- Durable inbound-event, outbound-delivery, action/audit, and error records

### Isolation requirements

- Every database access must be tenant-scoped; never query by a user/order identifier without tenant/store constraints.
- Queue jobs must include tenant ID and store ID and must validate them on execution.
- Telegram callback/action data must resolve to the correct tenant and authorized user.
- Encrypt secrets at rest and prevent them from appearing in logs, telemetry, errors, or Telegram messages.
- Authorization is based on membership and role, not merely on possession of a chat ID.

### Onboarding flow

1. Merchant installs the WordPress connector plugin (or later uses a verified alternative connection method).
2. Plugin authenticates/connects the store to the SaaS and registers/verifies required webhooks.
3. The SaaS creates or updates the store integration and runs a health check.
4. An authenticated Telegram deep link connects the manager's Telegram identity.
5. Manager selects preferences and completes a connection test.
6. The platform records completion and begins delivery.

## 8. WordPress Connector Plugin

The plugin must remain lightweight. It is an integration connector—not the business-logic engine.

Responsibilities:

- Secure installation, authentication, and store connection
- Register/update/remove approved WooCommerce webhooks
- Generate or exchange credentials securely
- Connection test and health-check endpoint
- Minimal settings page and diagnostic status
- Compatibility checks and clear recovery instructions
- Optional first-party event normalization only where WooCommerce webhooks are insufficient

It must not contain tenant business rules, queue orchestration, billing logic, or duplicated SaaS application logic.

## 9. Security and Privacy

- Authenticate and validate WooCommerce webhook requests; use per-store secrets and replay protection where possible.
- Encrypt WooCommerce credentials, webhook secrets, bot tokens, and other secrets at rest using a managed application encryption strategy and key rotation plan.
- Enforce HTTPS, secure headers, input validation, rate limiting, and least-privilege service credentials.
- Implement role-based access control (RBAC) for tenant and store actions.
- Require action confirmation and authorization for destructive or financial actions.
- Maintain immutable/auditable records for state-changing actions, including actor, tenant/store, before/after context when feasible, result, and correlation ID.
- Redact secrets and minimize personally identifiable information in logs and Telegram messages.
- Use secure verification for customer-bot order lookup.
- Define data retention, export, deletion, and backup policies before public launch; account for applicable Iranian and global privacy obligations as the product expands.
- Never store raw card details or attempt to become a payment-card data handler.

## 10. Reliability and Operations

- Retry transient external failures with bounded exponential backoff.
- Use dead-letter handling and an operator-visible failure/replay process.
- Make webhook ingestion, jobs, Telegram sends, and status changes idempotent.
- Monitor queue depth, failed jobs, webhook verification failures, WooCommerce API errors, Telegram errors, and integration health.
- Use structured logs with correlation IDs; never log secrets.
- Provide health/readiness endpoints and graceful shutdown for API and workers.
- Back up PostgreSQL regularly and test restore procedures.
- Batch/digest non-urgent notification bursts to avoid Telegram spam and rate-limit issues.
- Keep scheduled jobs timezone-aware and resilient to duplicate execution.

## 11. Localization and UX

- Initial UI/message language: Persian; support RTL formatting correctly.
- English is required for global expansion; Arabic is a later candidate.
- Store locale and timezone are configuration, not assumptions.
- Format money, dates, numbers, status labels, and templates by locale and store settings.
- Keep Telegram messages scannable: summary first, details on request, actions clearly labeled.
- Support customizable templates within safe variable and length limits.
- Do not hard-code translated business text in domain logic; use a translation/message layer.

## 12. SaaS Plans (Initial Product Direction)

| Plan | Intended capability |
| --- | --- |
| Free | One store, basic order notifications, basic reports, limited manager access |
| Pro | Full manager workflows, inventory, advanced reports, automations, multiple managers, optional customer bot where available |
| Agency | Multiple stores, team roles, centralized administration; white-label/API access are future options |

Exact limits, pricing, payment providers, and entitlements are product decisions to finalize before launch. Enforce limits server-side; never rely solely on the UI.

## 13. MVP v1 — Definition of Done

MVP v1 is the smallest reliable paid-capable product that proves merchants can operate common order work in Telegram.

### In scope

- Tenant/store onboarding through the connector plugin and verified Telegram manager linking
- Secure WooCommerce webhook ingestion for new orders and relevant order-status changes
- Manager notification with order summary and a safe detail view
- Authorized manager actions: view order, change to selected valid statuses, add note, refresh state
- `/orders`, `/order <number>`, `/search <query>`, `/report` (basic daily summary), and `/stock` (low-stock list) commands
- Low-stock notification/list with configurable threshold
- Tenant settings for manager recipients, timezone, language, and enabled notification categories
- PostgreSQL persistence, Redis/BullMQ background jobs, retry/dead-letter behavior, audit trail, logs, health checks, and backup plan
- Persian-first messages with an architecture ready for English
- Basic plan entitlement model, even if initial billing is managed manually

### Explicitly deferred from MVP

- Customer bot
- Refund execution, payment gateway/chargeback flows
- Review moderation
- Marketing automation, abandoned-cart, broadcasts, and win-back campaigns
- Invoice/label generation, partial fulfillment, advanced analytics
- Agency dashboard, white-labeling, public API, Kubernetes, AI features, voice commands, and additional channels

### MVP success criteria

- A real store can be connected without manual database edits.
- New order notifications reach an authorized manager reliably.
- A manager can safely complete the supported order actions in Telegram.
- Duplicate events/callbacks do not create duplicate state changes.
- Failures are visible, retryable, and auditable.
- Tenant A cannot view or affect Tenant B data.

## 14. Roadmap

### Phase 0 — Foundation

- Confirm brand/name, legal/billing approach, product analytics, and operational ownership
- Define domain model, API contracts, threat model, UX flows, and connector-plugin contract
- Establish local/dev/staging/prod environments and CI baseline

### Phase 1 — MVP v1

- Deliver the MVP definition above to pilot Iranian stores
- Gather support and workflow feedback; measure reliability and time saved

### Phase 2 — Operational depth

- Refined permissions, more order actions, inventory adjustments, richer reports
- Review workflows, refund request handling, more notification preferences/templates
- In-product onboarding, subscription billing, support/administration tools

### Phase 3 — Pro customer experience

- Optional verified customer bot, tracking, support handoff, consent-aware notifications
- Carefully introduce retention/marketing workflows

### Phase 4 — Agency and international expansion

- Agency multi-store controls, English/global localization, regional billing/integrations
- Public API, web dashboard where it adds value, white-label exploration

### Phase 5 — Advanced intelligence and channels

- AI summaries/insights, voice workflows, broader analytics, shipping/CRM/accounting integrations
- Evaluate WhatsApp, Slack, Discord, and marketplace integrations only when product demand and policy compliance justify them

## 15. Coding Principles

- Optimize for correctness, clarity, security, and operability before cleverness.
- Keep functions/modules small and cohesive; encode domain terms explicitly.
- Type all external input and output; validate at boundaries.
- Prefer explicit error handling and meaningful domain errors over silent fallback.
- Write tests for business rules, tenant isolation, authorization, webhook verification, idempotency, and status-transition rules.
- Use migrations for schema changes. Never depend on manual production database changes.
- Use configuration through validated environment variables and secrets management; commit no credentials.
- Document behavior that is non-obvious, security-sensitive, or integration-specific.
- Avoid premature microservices. Start as a well-modularized application with separate API and worker processes; split only for demonstrated operational reasons.
- Do not introduce a dependency, abstraction, or infrastructure service without a clear need and ownership plan.

## 16. Naming Conventions

Use names that describe the domain rather than implementation accidents.

| Area | Convention | Examples |
| --- | --- | --- |
| TypeScript files/directories | kebab-case | `order-action.service.ts`, `tenant-context/` |
| Classes/types/enums | PascalCase | `OrderActionService`, `TenantMembership` |
| Variables/functions | camelCase | `processWebhookEvent`, `storeId` |
| Database tables/columns | snake_case, plural tables | `stores`, `webhook_events`, `tenant_id` |
| API routes | plural nouns, versioned | `/v1/stores`, `/v1/webhooks/woocommerce` |
| Queue names | namespaced kebab-case | `woocommerce-events`, `telegram-delivery` |
| Queue job names | verb-noun | `process-webhook-event`, `send-telegram-message` |
| Environment variables | uppercase snake case with service prefix | `APP_ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN` |
| IDs | stable prefixed IDs if exposed externally | `ten_…`, `sto_…`, `evt_…`, `act_…` |

Avoid ambiguous names such as `data`, `utils`, `helper`, `manager`, and `service` without a domain qualifier.

## 17. Design Principles

- **Actionable over noisy:** each alert should support a decision, an action, or an intentionally configured awareness need.
- **Safe by default:** show only the minimum data needed; make destructive actions confirmable and reversible where possible.
- **Progressive disclosure:** use compact cards; reveal long details with buttons/commands.
- **State-aware:** only present actions valid for the current order/store state and user role.
- **Mobile-first:** Telegram messages and keyboard actions must be usable quickly on a phone.
- **Transparent:** clearly identify what changed, who/what initiated it, and whether it succeeded.
- **Accessible/localized:** make RTL, translations, dates, currencies, and tone first-class.
- **Graceful failure:** tell users what happened and what they can do next; never pretend an action succeeded.

## 18. AI Instructions for Future Coding Sessions

Before coding:

1. Read this document and inspect the current repository, existing architecture, tests, and decision log.
2. Identify whether the requested change affects tenant isolation, authorization, webhooks, queues, secrets, billing, user-visible Telegram UX, or migrations.
3. State assumptions briefly when they materially affect the solution. Ask for direction only when an unresolved product choice would significantly change scope or external behavior.

While coding:

1. Preserve the production architecture and architectural rules in this document.
2. Do not substitute n8n, a spreadsheet, an in-memory store, or manual operational steps for a required production capability without explicitly labeling it as temporary development scaffolding.
3. Never hard-code credentials, tenant/store IDs, chat IDs, URLs, locales, or plan limits.
4. Enforce tenant scope and authorization server-side in every read and mutation.
5. Validate incoming webhooks and Telegram callbacks; make externally triggered mutations idempotent.
6. Use queues for slow/retryable integrations. Do not perform long external work synchronously in webhook handlers.
7. Add/update migrations, tests, API schemas, and documentation when the change requires them.
8. Do not overwrite unrelated user changes. Keep commits/patches focused.

Before declaring work complete:

1. Run relevant lint, type-check, unit/integration tests, and a build when available.
2. Verify failure paths and duplicate-delivery behavior for integration changes.
3. Report changed files, verification performed, known limitations, and any decision that should be added below.

## 19. Recommended Repository Structure

This is a recommendation, not a mandate. A modular monorepo is appropriate once the plugin and backend coexist.

```text
.
├── apps/
│   ├── api/                    # NestJS/Fastify HTTP API and webhook ingress
│   ├── worker/                 # BullMQ processors, schedules, delivery workers
│   ├── bot/                    # Telegram update handling (or a module of api initially)
│   └── wordpress-plugin/       # Lightweight WooCommerce connector plugin
├── packages/
│   ├── domain/                 # Entities, use cases, policies, status transitions
│   ├── contracts/              # Shared DTOs, schemas, event contracts
│   ├── database/               # ORM/query layer, migrations, repositories
│   ├── integrations/           # WooCommerce and Telegram clients/adapters
│   ├── auth/                   # Tenant context, RBAC, crypto helpers
│   ├── i18n/                   # Message catalogs and formatters
│   └── config/                 # Validated configuration
├── infrastructure/
│   ├── docker/
│   └── caddy/
├── docs/
│   ├── architecture/
│   ├── adr/                    # Architecture decision records
│   └── operations/
├── tests/
│   ├── integration/
│   └── e2e/
├── scripts/
├── PROJECT-TELEGRAM-WC-SAAS.md
└── README.md
```

Keep the WordPress plugin release/build conventions compatible with WordPress requirements. If a monorepo adds unnecessary friction early, separate repositories are acceptable, provided contracts and versioning stay explicit.

## 20. Decision Log

Record material product and technical decisions here. Use an ADR under `docs/adr/` for decisions requiring detailed alternatives and consequences.

| Date | Decision | Status | Rationale / consequences |
| --- | --- | --- | --- |
| 2026-07-18 | Product focus is WooCommerce operations through Telegram, not notifications alone. | Accepted | Guides UX, pricing, and MVP action flows. |
| 2026-07-18 | Iran is the first target market; global expansion follows validation. | Accepted | Persian/RTL and timezone/localization must be designed in from the start. |
| 2026-07-18 | n8n is not the production SaaS core. | Accepted | It may remain for prototype/internal use only; production uses owned backend/workers. |
| 2026-07-18 | Preferred production stack: NestJS, PostgreSQL, Redis, BullMQ, grammY/Telegraf, WooCommerce REST/Webhooks, Docker, Caddy. | Accepted | Fastify remains an acceptable backend choice if deliberately selected. |
| 2026-07-18 | Multi-tenancy, tenant isolation, auditability, queues, and idempotency are foundational requirements. | Accepted | They are not optional post-launch enhancements. |
| 2026-07-18 | WordPress plugin is lightweight connector infrastructure. | Accepted | Business logic stays in the SaaS backend. |
| 2026-07-18 | MVP v1 prioritizes manager order operations, basic inventory visibility, reports, and reliable onboarding. | Accepted | Customer bot, marketing, and advanced integrations are deferred. |

## 21. Maintenance of This Memory

Update this document when a decision becomes durable and affects future work. Do not use it to track transient implementation details, credentials, deployment IPs, customer data, or secrets. Link detailed ADRs, API docs, runbooks, and product specifications from the repository documentation as they are created.
