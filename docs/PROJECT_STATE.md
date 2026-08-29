# PROJECT STATE

Version: 1.0

---

Current Phase

Phase 4 — Telegram Platform remains In Progress. M14 Practical Telegram
Management UX and M15 Public Account Authentication Foundation are merged and
closed on `main`. M16 Self-Service Store Onboarding is implemented on
`feat/m16-self-service-store-onboarding` and awaits A/B review plus one
controlled end-to-end validation. M12 real-store validation remains complete to
the extent recorded in
`docs/validation/M12_REAL_STORE_VALIDATION.md`.

---

Current Task

M16 implementation, connector work, automated coverage, and repository gates
are complete. Run the one controlled fresh-merchant onboarding validation after
A/B automated review. Do not begin a later milestone without approval.

---

Project Version

0.1.0

---

Repository

Initialized on branch main.

---

Backend

NestJS scaffold created.

Prisma ORM configured with PostgreSQL.

Initial six-model multi-tenant schema and migration created.

The `init_schema` migration was applied and verified in sync during clean-clone
verification.

Global PrismaModule and lifecycle-managed PrismaService are available for
injection in future backend modules without re-importing PrismaModule.

A backend smoke test verifies that the Nest application boots.

A global ApplicationConfigModule validates the environment before startup and
exposes typed application, PostgreSQL, Redis, JWT, encryption, Telegram, and
WooCommerce settings through ApplicationConfigService. Validation aggregates
failures, enforces development/test/production boundaries, and redacts secrets.

An AuthModule provides access-token signing and verification, Passport JWT
bearer validation, a global deny-by-default authentication guard, `@Public()`
route opt-out, and `@CurrentUser()` payload access. User persistence, login,
refresh tokens, RBAC, and tenant authorization remain outside Task 2.2.

Global backend infrastructure under `backend/src/common/` provides structured
JSON logging at the configured `LOG_LEVEL`, secret redaction, AsyncLocalStorage
request context with generated or preserved `x-request-id` correlation IDs, and
a normalized global error contract containing `statusCode`, `error`, `message`,
and `requestId`. The common layer contains cross-cutting infrastructure only.

The M2 tenant foundation extends that same request AsyncLocalStorage context
with the authenticated `tenantId`, `userId`, and membership role. A global guard
resolves active Membership records after JWT authentication, rejects missing or
unauthorized memberships, and skips explicit `@Public()` routes. Tenant-owned
Store access demonstrates the required TenantScopedPrisma pattern: tenant IDs
come only from server-side context and are injected into every read and write.

M3 adds persisted own-profile access, tenant creation with atomic OWNER
provisioning, tenant metadata and soft-delete operations, and tenant-scoped
membership listing, addition, role updates, and soft deletion. Membership roles
are constrained by the Prisma `MembershipRole` enum (`OWNER`, `ADMIN`,
`MEMBER`); serializable membership mutations prevent removing or demoting the
last active OWNER. JWT-protected `@TenantOptional()` routes are limited to own
profile and tenant bootstrap operations.

M4 adds tenant-scoped WooCommerce Store CRUD with soft deletion, AES-256-GCM
credential encryption through the typed application encryption setting, a thin
per-request WooCommerce REST client, and a credential-safe connection test.
Store responses use explicit Prisma selections that omit encrypted fields, and
cross-tenant or deleted records resolve as not found.

M5 adds append-only audit event creation for membership and store operations,
with tenant and actor identity sourced from server request context and strict
metadata allowlisting. One BullMQ operations queue and in-process reference
worker provide validated tenant-aware payloads, bounded exponential retries,
terminal structured error logging, Redis/PostgreSQL readiness checks, and clean
shutdown through Nest lifecycle hooks.

M6 hardens the per-request WooCommerce REST client with typed resilience
configuration, a five-second per-attempt timeout, a 15-second total cap, and up
to three attempts using 300/600ms exponential backoff with ±20% jitter. Retries
are restricted to transport failures, timeouts, HTTP 429, and HTTP 5xx.
WooCommerce failures normalize to six secret-safe categories without retaining
raw request errors or authorization data.

Store creation now validates live reachability and credentials before any Store
row is persisted. Credential-changing updates validate the proposed credential
set before any Store field is mutated, so failed validation preserves the
existing encrypted credentials and metadata. The existing connection-test
response shape is preserved. M6 adds no dependency, schema migration, webhook,
plugin registration, resource endpoint, or synchronization behavior.

M7 adds a single-use plugin registration handshake for pre-existing tenant
Stores. Store creation now persists `PENDING` after M6 WooCommerce REST
validation. OWNER and ADMIN members can issue a short-lived registration token;
only its SHA-256 hash, expiry, and consumption state are stored. The public
registration endpoint derives Store identity only from that token and uses the
M6 WooCommerce REST test—there is no SaaS→plugin probe or plugin endpoint URL.

Successful registration atomically consumes the token, replaces the hashed
persistent plugin→SaaS credential, records registration and last-seen time,
creates an audit event, provisions missing M8 material, and promotes the Store
from `PENDING` to `ACTIVE`. As extended by M16, connector webhook verification
separately sets healthy timestamps without owning that lifecycle transition.
Auth and transient failures leave all Store state unchanged. A
tenant-scoped connection-health endpoint exposes only status, timestamps, and a
registration boolean. A Redis fixed-window limiter applies only to public
plugin registration.

Store registration fields are introduced by migration
`20260722142357_store_registration_handshake`. The final `StoreStatus` literals
remain `PENDING`, `ACTIVE`, `DISCONNECTED`, and `DISABLED`.

M8 adds dedicated server-generated webhook secrets encrypted through the
existing AES-256-GCM service and unique opaque endpoint keys used only for Store
routing. M7 registration atomically provisions missing webhook credentials;
OWNER and ADMIN members can provision or rotate both values without re-exposing
an existing secret.

The public WooCommerce webhook route resolves an active Store by endpoint key,
validates required WooCommerce headers, verifies HMAC-SHA256 over exact raw
request bytes with a length-guarded constant-time comparison, and parses JSON
only after authentication. Tenant and Store identity always come from the
server-resolved Store.

Verified envelopes persist as `WebhookEvent` records deduplicated by Store and
delivery ID, then enqueue `woocommerce.webhook.process` on the existing
`operations` queue with a deterministic job ID. Enqueue failure leaves the
event `RECEIVED` for recoverable redelivery; later lifecycle states acknowledge
duplicates without another row or job. The worker advances operational state
through `QUEUED`, `PROCESSING`, `COMPLETED`, or terminal `FAILED` only and
performs no domain synchronization.

Migration `20260723120000_woocommerce_webhook_ingestion` was applied cleanly.
D-017 records the credential, authentication, idempotency, recovery, rotation,
scope, and structured-logging boundaries.

M9 adds tenant/Store-scoped Order snapshots with a unique
`(store_id, wc_order_id)` identity boundary. Verified `order.created` and
`order.updated` payloads map order number, status, currency, totals, customer
display data, line items, WooCommerce creation/modification timestamps, and a
canonical SHA-256 projection fingerprint without introducing related product,
customer, inventory, address, or line-item tables.

The M8 `woocommerce.webhook.process` worker now loads identity only through the
WebhookEvent Store relation. Older WooCommerce modification timestamps are
no-ops, newer snapshots apply, exact equal-timestamp duplicates are no-ops, and
equal-timestamp content conflicts reconcile through one bounded M6 order fetch.
Missing or unreliable timestamps and malformed snapshots with a stable order ID
use the same single-order reconciliation path.

WebhookEvent processing has a 30-second lease, attempt counter, normalized
failure category, bounded safe failure code, and last-failure timestamp.
Expired `PROCESSING` work can be reclaimed after a crash; active leases cannot
duplicate projection work. Retryable WooCommerce failures use the existing
three BullMQ attempts, while auth, not-found, malformed, and exhausted failures
remain terminal diagnostic records.

WooCommerce core source verification confirmed stable ID-only
`order.deleted` payloads and full REST-resource `order.restored` payloads. M9
therefore retains the Order snapshot while setting `remote_deleted_at`, and a
restore re-projects the snapshot and clears that marker. Generic reconciliation
not-found results remain terminal.

Migration `20260723180000_order_projection` applied cleanly in an isolated
PostgreSQL database. D-018 records projection ordering, canonical fingerprint,
lease recovery, reconciliation, and verified delete/restore boundaries.

---

Plugin

The WooCommerce connector now exposes a minimal WooCommerce admin page that
accepts exactly one M7 token. It derives Store identity only from the M7
response, stores required connector/webhook material with WordPress autoload
disabled, never re-renders secrets, creates or updates the four required order
webhooks, verifies their active topic/destination state, and calls the
plugin-credential-authenticated connection-health operation. Safe retry and
new-token reconnect guidance are included; no SaaS credentials, tenant/Store
selection, order logic, or business policy is present.

---

Telegram Bot

The grammY process now runs long-polling as a stateless transport adapter. It
accepts `/start`, `/start <token>`, `/status`, and `/unlink` with a single
inline confirmation step. Only private chats are processed; group, supergroup,
and channel updates receive one safe rejection and cannot change state.

The bot validates `TELEGRAM_BOT_TOKEN`, `BOT_INTERNAL_API_KEY`, and
`BACKEND_INTERNAL_URL`, calls only the NestJS internal Telegram API, propagates
correlation and Telegram update IDs, and writes no local persistent state. It
does not import Prisma or connect to PostgreSQL.

The backend owns Telegram link-token issuance, SHA-256 token hashing, atomic
redemption, one-to-one Telegram/SaaS identity constraints, private-chat
authorization, membership and active Store resolution, durable update
idempotency, status, and atomic soft unlinking. Active tenant and Store IDs are
set only when exactly one active Membership and exactly one non-deleted
`ACTIVE` Store exist.

Migration `20260723220000_telegram_account_linking` adds TelegramAccount,
TelegramChatAuthorization, and TelegramLinkToken and applied cleanly in an
isolated PostgreSQL database. Internal bot routes require `X-Bot-Api-Key`;
link-token issuance remains on the authenticated JWT user surface.

M11 adds bot-only `POST /api/internal/telegram/orders/list` and
`POST /api/internal/telegram/orders/detail`. Both re-resolve the linked
Telegram account, authorized private chat, active Membership and role, active
tenant, and exactly one active Store from server state. OWNER, ADMIN, and MEMBER
may read; inactive/deleted identities and ambiguous or changed contexts fail
through typed states without exposing ownership.

Order lists read only M9 projections in fixed eight-row pages ordered by
`wc_created_at DESC, wc_order_id DESC`. Full-boundary keyset references support
previous and next navigation without offset pagination, and the reachable
window is capped at 200 rows.

Because complete account/chat/tenant/Store/order bindings exceed Telegram's
64-byte callback-data limit, migration
`20260723230000_telegram_order_callback_references` adds expiring server-side
references. Callback data contains only a purpose prefix, random short ID, and
HMAC tag; every request validates signature, TTL, purpose, and current
account/chat/tenant/Store binding. The complete seven-migration chain applied
cleanly in an isolated PostgreSQL database and Prisma reported it up to date.

Order summaries and details expose sanitized projection fields only. Remotely
deleted Orders return a minimal marker without line items or customer details
beyond display name. Freshness uses the authoritative M9 `last_synced_at`
timestamp with a configured delayed threshold. The bot adds `/orders`, inline
pagination, detail selection, and back navigation while remaining a stateless
transport adapter with no Prisma, database, or WooCommerce access.

M12 adds bot-key-authenticated order-transition and status-write endpoints.
OWNER and ADMIN may write; MEMBER remains read-only. The backend re-resolves
the linked account, authorized private chat, active Membership and tenant, and
exactly one active Store for every request.

Order details expose a status action only when the backend role and current
projected status have available transitions. The transition endpoint issues a
short-lived `STATUS_WRITE` callback reference that binds the account, chat,
tenant, Store, WooCommerce order key, conservative core target set, and first
claimed target.

Migration `20260724090000_telegram_order_status_write` extends callback
references with bound/claimed target state and adds durable status-write
records unique by reference and target. Replays return the persisted result,
and a different target cannot reuse a claimed reference. The complete
eight-migration chain applied cleanly to an isolated PostgreSQL database and
Prisma reported it up to date.

The backend reads live WooCommerce state before dispatch, sends one status
write without automatic write retry, and projects the authoritative
WooCommerce response through M9. A missing response triggers one live
single-order reconciliation before success can be reported. Confirmed writes
emit secret-safe audit records. The grammY bot only renders backend targets and
forwards callbacks; it remains free of Prisma, database, WooCommerce, and
transition-policy logic.

Real-store validation exposed a bot transport timeout mismatch: WooCommerce
completed the selected status change, but Telegram's general 5,000ms backend
deadline expired and produced a false temporary-unavailability response. Commit
`fe36ab2` added a dedicated bounded status-write deadline without adding a
backend or WooCommerce write retry. The post-fix real-store regression completed
in approximately 7–13 seconds, WooCommerce reached the selected target state,
and Telegram no longer returned the unavailable message. The defect is fixed
and validated for the exercised real-store path.

M12-V is complete and merged. It adds two standalone Nest application-context
commands:
`pilot:setup` and `pilot:readiness`. Both require `PILOT_MODE=true`; the setup
also requires an approved public `PILOT_WEBHOOK_BASE_URL` using HTTPS and
refuses localhost, private-address, and non-origin URLs.

The setup command transactionally creates the first User, Tenant, and OWNER
Membership only in an empty bootstrap database. It is idempotent for that same
sole identity and refuses unrelated bootstrap data. It signs a legitimate
access token with the existing `AuthService` and keeps it in memory. Hidden
WooCommerce credential prompts feed the existing M4 fail-closed validation and
AES-256-GCM Store persistence.

M8 provisions the dedicated webhook secret and endpoint key. The existing
WooCommerce REST client now creates or updates the required `order.created`,
`order.updated`, `order.deleted`, and `order.restored` webhooks at the public
Caddy route, then verifies their active remote configuration before the pilot
Store is promoted from `PENDING` to `ACTIVE`. No plugin registration or
connector capability is claimed.

The final setup step uses the existing Telegram link-token service and prints
only the one-time `/start <token>` handoff. The operator creates the synthetic
order manually. Readiness reports nine secret-safe checks, polls within a
configured bound for the projected order, and exits successfully only when the
order is also available through the Telegram order flow. M12-V has no reset,
force, overwrite, deletion, public onboarding, plugin UI, billing, or teardown.

M13 hooks only the successful M9 `order.created` projection path. Current
eligible recipients are derived through the existing M10/M11 linked-account,
authorized-private-chat, active Membership, tenant, and exact-one-active-Store
resolution. One `TelegramOrderNotificationDelivery` is persisted per Order and
private-chat authorization, then scheduled with a deterministic job on the
existing `operations` queue.

Migration `20260820090000_order_event_notifications` adds the narrow delivery
model and its `PENDING`, `IN_FLIGHT`, `DELIVERED`, `RETRYABLE_FAILURE`,
`TERMINAL_FAILURE`, and `AMBIGUOUS` states. Delivered records are no-ops,
terminal and ambiguous outcomes are not retried, and unresolved in-flight
records become ambiguous. Only explicit Telegram rate-limit/server outcomes
use the existing M5 bounded retry policy.

The worker revalidates current context, loads the current tenant/Store-scoped
Order projection, creates native M11 detail references, and exposes the M12
transition entry only when the existing M12 capability permits it. The compact
message contains only the already-approved sanitized order number, status,
total/currency, and customer display name.

The grammY process now exposes one `BOT_INTERNAL_API_KEY`-authenticated private
prepared-message operation on the Compose network. It remains the sole Telegram
API transport and has no Prisma/database, tenant/Store, recipient/role, Order,
or status-policy access. `BOT_INTERNAL_URL`, `BOT_INTERNAL_PORT`, and
`BOT_DELIVERY_TIMEOUT_MS` configure the private path; it has no Caddy route or
published host port. D-023 is Accepted.

M14 adds one stateless Telegram navigation and rendering layer over the existing
M10–M13 contracts. Home connects Recent Orders, Status, and Help; `/start`,
`/status`, `/orders`, `/help`, and the Telegram command menu expose existing
functionality consistently. Order list/detail Back actions still use M11's
signed, expiring references, while fixed Home/Recent Orders/Status/Help
callbacks re-enter the existing backend authorization endpoints and carry no
tenant, Store, order, role, or mutation state.

M13 notification detail and status callbacks remain native M11/M12 references.
Their presentation now continues through consistent detail, status-selection,
status-result, Back, and Home screens. Empty, expired, context-changed,
unauthorized, no-active-Store, malformed-response, transport-failure, deleted,
not-found, and status-write outcome screens provide explicit safe recovery.
Message edits retain the existing reply fallback. M14 adds no schema,
persistence, backend contract, business command, authorization, callback
security, order, delivery, or mutation behavior.

M15 adds public `POST /api/auth/register` and `POST /api/auth/login` endpoints
inside the existing AuthModule. Both normalize email by trim-and-lowercase,
apply independent Redis fixed-window limits keyed by hashed IP and normalized
email, and issue the existing AuthService JWT format with only the User subject.
Registration and login never create a Tenant, Membership, Store, or active
tenant context; the existing M3 `POST /api/tenants` operation remains the sole
first-Tenant/OWNER bootstrap.

Migration `20260828120000_public_account_authentication` adds only nullable
`users.password_hash` and refuses normalized historical email collisions before
altering the table without rewriting existing data. Passwords use Argon2id;
unknown-email, incorrect-password, and existing nullable-hash User login paths
share the same safe failure contract, with the non-credential paths performing
a bounded initialized dummy Argon2id verification. Explicit User selections,
response mapping, JWT payload tests, structured-log fingerprints, and expanded
redaction prevent password/hash disclosure. No tenant-scoped AuditLog is used
for these pre-tenant operations.

M15 adds typed independent registration/login limit configuration and the
approved `argon2` runtime dependency. Focused M15 tests plus the full M3–M14
regression suite pass: 243 backend tests and 32 Telegram bot tests. Prisma
validate/generate, build, typecheck, formatting, and migration-structure checks
pass. The backend Dockerfile installs `python3`, `make`, and `g++` as a temporary
Alpine virtual package in both dependency-install stages, removes the package
after `npm ci`, and retains a working Argon2id addon without Python or compiler
tools in the runtime image. A clean no-cache image build and runtime Argon2id
verification pass. VPS migration apply/status remains pending.

M16 adds authenticated `POST /api/auth/tenant-context`. It accepts no Tenant or
Store identity and derives the JWT subject from the authenticated request.
Zero active Memberships return a safe M3-bootstrap requirement, exactly one
active Membership issues the existing AuthService JWT format with that Tenant,
and multiple active Memberships fail because selection is outside M16.

The framework-free `/onboarding` surface is served through the existing NestJS
and Caddy topology. It keeps JWTs in memory, submits WooCommerce REST
credentials directly to existing M4/M6 Store creation, clears credential input,
and derives progress from current Store/connection-health data. It never calls
the M8 browser credential route and places no JWT, WooCommerce credential, M7
token, plugin credential, or webhook secret in a URL or browser store.

The current successful fresh M7 response remains authoritative:
`{ pluginCredential, storeId, webhookSecret, webhookEndpointKey }`. Existing
webhook material remains non-reexposable on re-registration. For a fresh Store,
M7 records registration, returns the one-time M8 material, and preserves its
established `PENDING` to `ACTIVE` transition. The connector installs/verifies
`order.created`, `order.updated`, `order.deleted`, and `order.restored`, then
authenticates with the plugin credential. The backend independently reads
WooCommerce webhook configuration and records healthy timestamps only when all
required topics share the exact HTTPS endpoint-key destination; it does not own
Store activation.

M10 link-token issuance now re-resolves exact-one active Membership and
exact-one `ACTIVE` Store with webhook credentials and a healthy timestamp.
Ineligible direct API calls fail before token persistence; M10 redemption and
the M11–M14 experience remain unchanged. M12-V remains functional by recording
its already-verified pilot Store health when it activates that Store.

M16 adds no schema migration or dependency. Backend tests now pass at 258 and
bot tests remain at 32. Build, typecheck, lint, formatting, Prisma
validate/generate, connector contract checks, and diff checks pass. Native PHP
syntax/runtime validation remains part of the controlled WordPress validation
because PHP and Docker are unavailable in the current workspace.

---

Infrastructure

Docker Compose and Caddy scaffolds created.

Compose networking is project-scoped to avoid cross-project collisions.

Basic GitHub Actions CI runs Prisma validation/generation, build, type-check,
lint, formatting, and the backend smoke test.

---

Production Stack

NestJS

PostgreSQL

Redis

BullMQ

grammY

Docker

Caddy

WooCommerce REST API

WooCommerce Webhooks

---

Current Branch

feat/m16-self-service-store-onboarding

---

Known Issues

DATE-001 — WooCommerce admin mixed/invalid calendar display: some orders show
Gregorian dates, some show Persian/Jalali dates, and one synthetic order showed
the impossible date `دی 17, 2647`. Current evidence shows valid WCTM PostgreSQL
Order, webhook, sync, and M13 notification timestamps, with no demonstrated
impact on M13 or current WCTM processing. This is not an M13 blocker; investigate
it before wider MVP pilot usage because date-dependent sorting or reporting may
eventually be affected.

AuditLog structural immutability is not yet enforced; the schema includes an
updatable timestamp. A future approved decision must define enforcement.

The production backend image omits the Prisma CLI because production dependency
installation excludes the Prisma development dependency. M3 migrations were
verified with the Docker builder stage; the production migration execution path
requires a future approved infrastructure correction.

---

Technical Debt

AuditLog immutability enforcement is deferred to a future approved task.

---

Current Blockers

No M16 implementation or automated-test blocker remains. The current workspace
has neither a PHP runtime nor an available Docker daemon, so native `php -l` and
the controlled WordPress/WooCommerce ceremony remain manual. Existing M15 VPS
migration apply/status, bounded M14 Telegram UX, and M13 deployed synthetic-
notification checks remain separate deployment validation items.

---

Next Milestone

No later product milestone is assigned. Review M16 and run its one controlled
fresh-merchant onboarding validation; do not begin later work without approval.

---

Last Completed

M16 Self-Service Store Onboarding implementation and automated regression
gates. A/B review and one controlled end-to-end validation remain.

---

Project Health

Excellent

---

Last Updated

2026-08-29
