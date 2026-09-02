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

## D-013

Date

2026-07-20

Decision

Backend environment configuration is centralized in a global NestJS
ApplicationConfigModule. It uses `@nestjs/config` for framework integration and
Joi for validation, with application consumers restricted to the typed
ApplicationConfigService.

Reason

`@nestjs/config` matches the NestJS 11 architecture already in use. Joi provides
declarative conversion, environment-specific rules, and aggregated validation
without introducing a custom validation framework. A custom error formatter
ensures secret values never appear in validation output.

Boundary

Raw environment access is limited to the configuration validation boundary and
the standalone Prisma CLI configuration. Application bootstrap and services use
typed configuration accessors.

Status

Accepted.

---

## D-014

Date

2026-07-21

Decision

The initial background-job topology uses one BullMQ `operations` queue and one
in-process worker managed by the NestJS backend lifecycle. Reference jobs have
three total attempts with exponential backoff starting at one second. Exhausted
jobs remain in BullMQ's failed set and emit a structured, secret-safe error log.

Reason

This is the minimum production-operable topology for the current modular
backend. It proves enqueue, processing, bounded retry, failure visibility, and
graceful shutdown without adding a separate deployment process before business
workers exist.

Boundary

Every job payload is validated and carries `tenantId`, plus `storeId` when
relevant. Splitting workers into a separate process or changing retry policy
requires a later approved task.

Status

Accepted.

---

## D-015

Date

2026-07-22

Decision

WooCommerce REST validation uses three total attempts, a five-second timeout per
attempt, and a 15-second hard operation cap. Retry delays use exponential
backoff starting at 300 milliseconds with factor two and ±20% jitter. Only
transport failures, timeouts, HTTP 429, and HTTP 5xx are retried.

Store creation must validate live WooCommerce reachability and authentication
before persistence. A credential-changing Store update must validate the
proposed credential set before replacing encrypted values; every validation
failure fails the operation without mutating the Store.

Reason

Fail-closed validation prevents unusable or unverified credentials from becoming
active tenant data while bounded retries tolerate transient WooCommerce and
network failures without extending request duration indefinitely.

Boundary

Failures normalize to the secret-safe categories `auth`, `not-found`,
`transport`, `rate-limited`, `timeout`, and `unexpected`. This decision adds no
WooCommerce resource operations, webhook behavior, plugin registration, sync
service, dependency, or schema change.

Status

Accepted.

---

## D-016

Date

2026-07-22

Decision

MVP plugin registration verifies Store reachability and authentication only
through the existing SaaS→WooCommerce REST client. There is no SaaS→plugin
probe, plugin endpoint URL, or plugin-channel verification.

Registration tokens are one-time, TTL-bounded handshake credentials stored as
SHA-256 hashes. Successful registration returns a separate persistent
plugin→SaaS credential exactly once and stores only its SHA-256 hash. If the
success response is lost, an OWNER or ADMIN must issue a new registration token;
successful re-registration generates a new plugin credential and replaces the
prior hash. Replaying the consumed token never reproduces or rotates a
credential.

`POST /plugin/register` alone uses a minimal Redis fixed-window rate limiter
keyed by a hash of client IP plus the registration-token hash prefix. The limit
and window are typed configuration values; no global throttling guard is added.

Reason

These boundaries keep WooCommerce REST authentication, one-time registration,
and persistent plugin authentication independent; preserve recoverable,
single-use plaintext handling; and bound public registration abuse without
expanding application-wide rate-limiting scope.

Status

Accepted.

---

## D-017

Date

2026-07-23

Decision

WooCommerce webhook authentication uses a dedicated server-generated secret of
at least 32 random bytes, encrypted at rest with the existing AES-256-GCM
application encryption service. It is never derived from or shared with the
persistent plugin credential.

Each Store receives a separate unique, indexed, URL-safe
`webhook_endpoint_key`. The endpoint key is opaque routing information only; it
is not an authentication factor. Authentication is exclusively
`base64(HMAC-SHA256(rawBody, webhookSecret))`, verified over the exact request
bytes with a length guard and constant-time comparison.

Verified events are deduplicated by the database constraint on Store ID and
WooCommerce delivery ID. Publication uses a deterministic BullMQ job ID derived
from the persisted WebhookEvent ID. Persistence and enqueueing are a recoverable
two-step operation: persist `RECEIVED`, enqueue on the existing `operations`
queue, then mark `QUEUED`. Enqueue failure leaves `RECEIVED` for an idempotent
WooCommerce redelivery.

OWNER and ADMIN memberships may provision missing webhook credentials or rotate
both the secret and endpoint key. Rotation replaces both values atomically and
the prior secret stops authenticating immediately. Newly generated plaintext
secrets are returned once; existing secrets are never re-exposed.

Reason

Separating routing from authentication and separating webhook credentials from
plugin credentials limits credential reuse and makes rotation explicit. The
database uniqueness constraint plus deterministic queue identity handles
at-least-once delivery without requiring a distributed transaction between
PostgreSQL and Redis.

Boundary

M8 persists and schedules verified envelopes only. Its worker advances
operational lifecycle state with the existing bounded retry/dead-letter policy
and performs no order, product, customer, inventory, or other domain
synchronization. Monitoring remains existing correlation-aware structured logs;
no metrics platform, metrics endpoint, or readiness dead-letter count is added.

Status

Accepted.

---

## D-018

Date

2026-07-23

Decision

Verified WooCommerce `order.created`, `order.updated`, `order.deleted`, and
`order.restored` WebhookEvents project into a tenant/Store-scoped Order snapshot
identified uniquely by Store ID and WooCommerce order ID.

WooCommerce `date_modified_gmt` is the primary ordering field. Older projections
are no-ops; newer projections apply; equal timestamps with equal stable
fingerprints are no-ops; equal timestamps with different fingerprints require
one authoritative M6 single-order fetch. Missing or unreliable modification
timestamps and otherwise malformed snapshots with a stable order ID use that
same bounded reconciliation path.

WebhookEvent processing uses a 30-second database lease. `RECEIVED` events
whose deterministic job is already executing, `QUEUED` events, and expired
`PROCESSING` leases may be claimed atomically; active leases do not duplicate
projection work. Claiming the post-publication `RECEIVED` window prevents the
worker from racing M8's separate `QUEUED` acknowledgement. Retryable
reconciliation failures return to `QUEUED` for the existing three BullMQ
attempts. Terminal or exhausted failures remain `FAILED` with an M6-normalized
category, bounded safe code, attempt count, and failure timestamp.

WooCommerce core source verification established that `order.deleted` builds an
ID-only payload and `order.restored` builds the normal REST resource payload.
M9 therefore sets `remote_deleted_at` on an existing snapshot for verified
delete topics and clears it by re-projecting verified restore topics. A generic
M6 `not-found` reconciliation result remains terminal because it cannot safely
distinguish a missing order from a missing REST route.

Reason

Database uniqueness, source modification time, canonical fingerprints, and
bounded lease recovery provide deterministic at-least-once processing without a
new queue or distributed lock. Single-order reconciliation repairs uncertain
state without introducing full-store sweeps, polling, or historical imports.

Boundary

M9 synchronizes Orders only. It adds no Telegram behavior, WooCommerce writes,
product/customer/inventory/address domain models, bulk synchronization, replay
API/UI, scheduler, or metrics platform.

Status

Accepted.

---

## D-019

Date

2026-07-23

Decision

Telegram account linking uses one-time, short-lived, cryptographically random
tokens issued from the authenticated SaaS user surface. Only SHA-256 token
hashes are persisted. Redemption is atomic and binds one Telegram user to one
SaaS User plus one authorized private chat; groups, supergroups, and channels
cannot become authorized.

All Telegram identity persistence, token validation, membership lookup, and
tenant/Store context resolution remain in the NestJS backend. The standalone
grammY process is a stateless long-polling transport and presentation adapter
that never imports Prisma or opens a database connection.

Bot-only internal endpoints bypass the global JWT guard only to enforce a
dedicated `X-Bot-Api-Key` guard using the typed `BOT_INTERNAL_API_KEY`
configuration. Every bot request propagates `X-Correlation-Id` and
`X-Telegram-Update-Id`. Redeem and confirmed unlink operations are transactionally
idempotent by Telegram user and update ID.

Active context is selected automatically only when the linked User has exactly
one active Membership and that tenant has exactly one non-deleted `ACTIVE`
Store. Otherwise both active IDs remain null and selection is reported as
required. M10 adds no selection/switching command.

Unlink requires explicit private-chat confirmation and atomically soft-revokes
the TelegramAccount and all of its chat authorizations.

Reason

This boundary preserves tenant and membership authorization in the backend,
prevents possession of a chat ID from becoming authorization, keeps the bot
recoverable and free of local persistent state, and makes duplicated Telegram
updates and timeout-after-commit recovery safe.

Boundary

M10 includes `/start`, `/status`, and confirmed `/unlink` account-linking
behavior only. It adds no order management, Store switching, group support,
webhook transport, or other Telegram operational commands.

Status

Accepted.

---

## D-020

Date

2026-07-23

Decision

Telegram order access reads only M9 projections through bot-key-authenticated
internal endpoints. Every request resolves the linked Telegram account,
authorized private chat, active Membership, tenant, and exactly one active
Store again in the backend. OWNER, ADMIN, and MEMBER roles may read; the bot
never receives or supplies tenant, Store, or raw order ownership identifiers.

Order lists use a fixed eight-row keyset ordered by WooCommerce creation time
descending and WooCommerce order ID descending. Cursors carry the full boundary,
direction, and reachable offset through a server-side reference, and the
reachable window ends after 200 rows.

Telegram's 64-byte callback-data limit is handled with short opaque references.
The callback contains only a purpose prefix, a random 12-byte reference ID, and
a truncated HMAC-SHA256 tag. The expiring server-side reference binds the
Telegram account and chat, tenant, Store, purpose, order key or keyset boundary,
issuance time, and TTL. Every use validates the signature, expiry, purpose, and
current context. Replays are harmless because M11 is read-only.

Freshness is derived from the M9 `Order.lastSyncedAt` projection timestamp.
Delayed state uses a typed configurable threshold. An empty projection set uses
the Unix epoch with `delayed: true` so absence is never presented as fresh.

Reason

Keyset pagination remains deterministic while new orders arrive, and
server-side callback references preserve complete authorization/context binding
without exposing raw identifiers or exceeding Telegram's callback limit.
Backend-owned resolution keeps the grammY process stateless and prevents stale
keyboards from authorizing data after membership or Store context changes.

Boundary

M11 adds `/orders`, list pagination, and inline read-only order detail only. It
adds no direct `/order` lookup, WooCommerce request, reconciliation, order
mutation, Store switching, group support, notification delivery, or later
Telegram command.

Status

Accepted.

---

## D-021

Date

2026-07-23

Decision

Telegram order-status writes use server-issued, short-lived
HMAC-authenticated callback references with a dedicated `STATUS_WRITE`
purpose. Each reference binds the Telegram account and private chat, tenant,
Store, WooCommerce order key, server-derived allowed target set, issuance
lifetime, and the first claimed target. OWNER and ADMIN memberships may write;
MEMBER remains read-only. Full account, chat, Membership, tenant, and
exactly-one-active-Store context is re-resolved for every request.

The backend offers a conservative mapping of WooCommerce core status
transitions and revalidates the selected target against live WooCommerce state
before dispatch. Telegram only renders the targets returned by the backend and
contains no status policy. The current mapping is:

- `pending` → `processing`, `on-hold`, `cancelled`
- `processing` → `on-hold`, `completed`, `cancelled`, `refunded`
- `on-hold` → `processing`, `completed`, `cancelled`, `refunded`
- `completed` → `processing`, `refunded`
- `cancelled` → `pending`
- `failed` → `pending`, `on-hold`, `cancelled`
- `refunded` → no target

Each reference is single-effect: its first target claim is durable, and a
separate write record is unique by callback reference and target. Replays
return the persisted result without another WooCommerce write. The
WooCommerce update uses one dispatch without automatic write retry. If the
response is lost, the backend reads the live order and reports success only
when WooCommerce confirms the target.

WooCommerce is authoritative. Successful update responses, no-op live reads,
and lost-response reconciliation reads pass through the M9 authoritative
projection path. The local projection never drives a WooCommerce write result.
Successful status changes create a secret-safe audit record.

Reason

Server-owned transition policy and context-bound references prevent the bot or
stale keyboards from selecting unauthorized state. Durable target claiming
and result persistence prevent duplicate callbacks from repeating an external
write, while live reconciliation prevents false success after an ambiguous
network outcome.

Boundary

M12 adds only Telegram-initiated order status changes. It adds no notes,
refund execution, direct order lookup, Store switching, custom-status
discovery, notification delivery, or other order mutation.

Status

Accepted.

---

## D-022

Date

2026-07-25

Decision

M12-V adds two private-pilot operator commands, `pilot:setup` and
`pilot:readiness`, as the supported validation bootstrap preceding M12 V1.
These commands are available only when `PILOT_MODE=true`, support exactly one
pilot User, Tenant, OWNER Membership, and Store, and refuse unrelated existing
bootstrap data.

The bootstrap has no reset, force, overwrite, teardown, or deletion path.
Operator JWT internals remain hidden: the command issues the access token
through `AuthService`, keeps it in memory, and uses the existing configured
access-token TTL. WooCommerce credentials are entered without terminal echo and
flow directly through the existing fail-closed encrypted Store validation.

Remote WooCommerce webhook registration requires an approved public HTTPS
origin routed through Caddy. Localhost, private-address, non-HTTPS, and tunneled
topologies are outside the supported pilot path. The backend retains ownership
of the dedicated encrypted webhook secret and opaque endpoint key.

Telegram linking remains a one-time `/start <token>` handoff. Creating the
synthetic order is deliberately manual and must use no real payment or
customer. M12-V is private-pilot validation tooling only; it is not public
onboarding, plugin UI, connector completion, billing, or a Phase 5 feature.

Reason

Real-store validation cannot begin from an empty database through the current
public surfaces, while manual SQL, JWT signing, secret copying, and an
unverified connector artifact would violate the approved security boundary.
The two bounded operator commands provide the minimum supported path without
expanding product onboarding scope.

Status

Accepted.

---

## D-023

Date

2026-08-20

Decision

Successfully projected WooCommerce `order.created` events schedule one durable
Telegram notification delivery per Order and authorized private-chat
authorization. Recipient discovery and pre-dispatch revalidation reuse the
existing M10/M11 exact-one-membership and exact-one-active-Store context
behavior; M13 defines no independent role or Store-selection policy.

The backend owns the delivery state machine (`PENDING`, `IN_FLIGHT`,
`DELIVERED`, `RETRYABLE_FAILURE`, `TERMINAL_FAILURE`, and `AMBIGUOUS`), database
uniqueness, deterministic jobs on the existing `operations` queue, sanitized
content, and existing M11/M12 action creation. Confirmed delivery is never sent
again, terminal or ambiguous outcomes are not retried, and an unresolved
in-flight record becomes ambiguous rather than being blindly resent. Only a
definitive no-delivery transient outcome uses M5's existing three bounded
attempts.

The grammY process remains the only Telegram API transport. It exposes one
private prepared-message send operation on the internal Compose network,
authenticated with the existing `BOT_INTERNAL_API_KEY`; the endpoint has no
published host port or public Caddy route. The bot has no Prisma access, tenant
or Store resolution, recipient/role policy, Order logic, or status-transition
logic.

Notification **View Order** buttons use native M11 `ORDER_DETAIL` references.
**Change Status** appears only when the existing M12 capability permits it and
enters the unchanged M12 transition callback.

Reason

The narrow durable record and conservative ambiguous-outcome handling provide
restart-safe at-least-once processing without claiming exactly-once behavior
across an unknowable Telegram network outcome. Keeping authorization,
idempotency, content, and actions in the backend preserves tenant isolation and
keeps the bot stateless.

Boundary

M13 adds new-order manager notifications only. It adds no preferences, other
notification categories, search, analytics, AI, customer messaging, new RBAC,
new status policy, Store selection, new queue/service, backend Telegram API
client, or later milestone behavior.

Status

Accepted.

---

## D-024

Date

2026-08-31

Decision

MVP settings ownership is explicit: Tenant owns timezone and language, while
Store owns low-stock threshold, enabled notification categories, and manager
recipient policy. There are no Store-specific timezone/language overrides and
no generic settings/property-bag model.

Selected notification recipients reference Memberships, never Telegram
accounts, user IDs, chat IDs, or chat authorizations. M10 remains the sole
authority for Telegram linking and private-chat authorization. A selected
Membership is usable only while current backend state still resolves its active
tenant Membership, permitted role, active M10 Telegram account, authorized
private chat, and exact current Store context. Unlinking does not delete the
preference, and legitimate relinking of the same Membership may restore future
eligibility without transferring authorization.

Recipient modes are legacy-compatible `ALL_ELIGIBLE` and explicit `SELECTED`.
`SELECTED` with no selected Memberships means no recipients. M13 remains the
backend-owned delivery state machine and gains only category/recipient filtering
at scheduling plus policy revalidation before dispatch. Existing delivery
history is retained.

The grammY bot remains stateless and presentation-only. Settings callbacks and
next-message inputs use short-lived, opaque, signed, account/chat/Tenant/Store-
bound backend references. M18 stores `fa`/`en`, IANA timezone, threshold, and
the two approved categories only; it does not implement M19 inventory, M20
search/reporting, or M21 general localization.

Reason

Direct ownership and Membership-based selection preserve tenant isolation,
M10 authorization authority, M13 delivery semantics, unlink/relink continuity,
and duplicate-safe Telegram actions without a generic configuration system or
bot-owned state.

Status

Accepted.

---

## D-025

Date

2026-09-01

Decision

WooCommerce remains the sole inventory authority for product and variation
identity, stock ownership, quantity, status, display context, and remote
lifecycle. M19 persists only a narrow Store-scoped `InventoryItem` projection
for current `/stock` reads, modification-time/fingerprint stale protection,
remote deactivation, and a per-item alert incident generation. WCTM exposes no
stock mutation endpoint, action, or queue job.

Current state is established by a one-time resumable bootstrap on the existing
`operations` queue. Each deterministic continuation performs one bounded
WooCommerce product or variation page read, persists page/parent/revision
progress, and marks the Store ready only after every required page succeeds.
Bootstrap projections are baselines and schedule no historical alerts. There is
no order-history import, historical product version import, periodic catalog
poll, permanent sweep, new queue, scheduler, worker process, or generic sync
framework.

Ongoing projection consumes only authenticated M8 `product.created`,
`product.updated`, `product.deleted`, and `product.restored` events. The M8
Store route remains server-derived, raw-byte HMAC authentication and
Store/delivery deduplication remain unchanged, and product events do not enter
the M9 Order projector. Equal conflicting or malformed events use at most the
minimum safely identified WooCommerce item read; older events cannot regress a
newer projection, including during bootstrap.

Inventory boundaries follow physical stock ownership. A product or variable
parent that manages stock is one item. A variation that independently manages
stock is its own item with bounded parent/display context. A variation that
explicitly inherits parent stock is not a second item or alert. An unmanaged
product or variation that does not represent a parent-owned pool may remain
visible when WooCommerce explicitly reports `outofstock`.

`Store.lowStockThreshold` is the sole WCTM quantitative threshold.
WooCommerce `outofstock` always classifies as `OUT_OF_STOCK`; otherwise a
stock-managing numeric item at or below the non-null Store threshold is
`LOW_STOCK`; all other states are `HEALTHY`. Threshold changes rebaseline the
projection without alert sources, so settings changes alone never create a
notification flood.

Low-stock delivery uses a dedicated durable inventory delivery record keyed by
inventory item, incident generation, alert level, and private-chat
authorization. One incident may send LOW once, may escalate to OUT once, does
not send on partial recovery, and rearms only after HEALTHY without a
back-in-stock message. Scheduling and pre-dispatch checks consume D-024's exact
`LOW_STOCK` category, `ALL_ELIGIBLE`/strict `SELECTED` Membership policy, and
current M10 authorization. A narrow Store policy generation prevents a later
disable/re-enable or recipient-policy round trip from reviving an already
captured delivery, while the existing chat-authorization update timestamp
prevents unlink/relink from reviving it. Confirmed and ambiguous outcomes retain
D-023's no-resend rule through the existing prepared-message bot transport.

The grammY bot remains database-free and presentation-only. `/stock` re-resolves
the current account, authorized private chat, active Membership, Tenant, and
exact-one active Store in the backend; OWNER, ADMIN, and MEMBER may read.
Eight-row pagination and item detail use short-lived signed backend references
that expose no Tenant, Store, or WooCommerce item ID in callback data.

Reason

This boundary provides durable current inventory visibility and transition
notifications while preserving WooCommerce ownership, M1–M18 tenant and queue
architecture, M10 authorization, M13 delivery safety, and M18 Store policy. A
narrow projection and incident record are sufficient for restart recovery and
duplicate suppression without creating a catalog or inventory mutation domain.

Boundary

M19 includes current inventory bootstrap, the four core product webhooks,
read-only `/stock`, and LOW/OUT incident delivery only. It adds no stock write,
generic product management, historical import, polling, back-in-stock message,
search, report, localization rollout, entitlement, billing, dashboard, Store
switching, new service/process, new queue topology, or M20+ work.

Status

Accepted.

---

## D-026

Date

2026-09-03

Decision

M20 Search & Daily Report is Store-scoped and projection-only. Search reads
current non-deleted Order projections and current active InventoryItem
projections. It supports deterministic exact/prefix matching over Order number,
projected customer display name, Inventory SKU, and Inventory display name.
There is no email/phone search, standalone Customer entity, generic Product
catalog, fuzzy/semantic search, or live WooCommerce search.

Ranking is fixed: unique exact Order number opens the existing M11/M17 native
detail; otherwise exact Order number, exact SKU, exact customer/inventory name,
identifier prefix, then name prefix are ordered deterministically, with Order
before Inventory at an equal rank and stable per-entity tie-breakers. Results
use eight-row pages within a 200-result window. Short-lived signed references
bind the Telegram account, private chat, active Membership, Tenant, Store,
purpose, and page/result state. Normalized query state is encrypted at rest;
callback data contains no query or protected identity.

`/report` is an on-demand Telegram projected operational daily summary only.
Tenant timezone defines the local civil day; its start and next-day start are
converted to UTC and applied to `Order.wc_created_at` as a half-open interval.
Orders-created-today and current status distribution exclude remotely deleted
Orders. Gross operational sales and per-currency average order value include
only current `processing` and `completed` Orders, never combine currencies, and
are not accounting/net revenue. LOW/OUT counts use the current M19 projection
only when inventory is `READY`; otherwise the report states that inventory is
unavailable. Delayed Order projection state is surfaced conservatively.

Reason

Existing Order, InventoryItem, timezone, authorization, signed-reference, and
navigation foundations are sufficient for bounded read-only operational search
and reporting. Reusing them preserves M1-M19 authority and security boundaries
without a search platform, analytics model, scheduler, historical import, or
new WooCommerce read path.

Boundary

M20 adds no live WooCommerce search/report read, Customer/Product/report model,
report persistence, scheduled delivery, notification category, historical
import, analytics platform, M21 localization, M22 entitlements, or mutation.
Existing M1-M19 authority, security, projection, queue, delivery, and Store
state boundaries remain unchanged.

Status

Accepted.

---

Next decision number: D-027.
