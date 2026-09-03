# PROJECT STATE

Version: 1.0

---

Current Phase

Phase 5 — Core Store Management (MVP) is in progress. M21 Notification /
Localization Completion is implemented on its feature branch and awaits B
review, merge, deployment, and production validation. M20 Search & Daily Report
is fully complete, merged, deployed, hotfixed, and operationally validated.
M19 Inventory & Low-Stock MVP is implemented, merged, deployed, and fully
operationally validated. Its production migrations, backend, telegram-bot,
updated connector, eight
canonical WooCommerce webhooks, health/readiness, bootstrap, projection,
`/stock`, threshold behavior, LOW/OUT incident lifecycle, M18/M10 recipient
integration, and durable delivery all passed. M18 and M17 remain fully closed.
Phase 4 and M1–M16 remain complete and unchanged.

---

Current Task

M21 — Notification / Localization Completion implementation is complete under
approved D-027. Repository validation is complete; B review, merge, backend and
telegram-bot deployment, and the authorized production validation remain. Do
not mark M21 operationally closed before those steps and do not begin M22.

---

Project Version

0.1.0

---

Repository

Current branch: `feat/m21-notification-localization-completion`.

M20 final implementation merge: `0281bb0 merge: complete M20 search and daily
report`. Numeric-SKU correction:
`c38af6edb2758c8c3f7b5b5a7b696fbf9a658827 fix(search): preserve numeric SKU
fallback`, merged through `4b66c9a merge: fix M20 numeric SKU search`.

M19 implementation commits `2143de4 feat(inventory): add low-stock MVP` and
`047b306 fix(inventory): harden delivery recipient identity` were merged to
`main` in `74ac6bd merge: complete M19 inventory low-stock MVP`.

M19 production correction commits: `8f13fd3 fix(inventory): accept unset
managed stock quantity`, `00f4f4c fix(inventory): tolerate missing display
names`, `242d72a fix(settings): repair inventory threshold rebaseline`, and
`ef0957b fix(inventory): allow stock notification callbacks`.

M18 implementation commit: `ef677f0 feat(settings): add MVP store settings
foundation`. The final adversarial-audit hardening is committed separately on
the same branch.

Production defect-fix commit: `892fc925 fix(webhooks): close pre-claim
publication race`.

M17 implementation commit: `feat(orders): complete MVP order workflow`.

M16 remains merged in `9e831a9 merge: complete M16 self-service store onboarding`.

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

M18 live validation exposed a pre-existing M8/M9 publication race. M8 persists
`RECEIVED`, publishes the deterministic BullMQ job, and then acknowledges
`QUEUED`; a worker could start between publication and that acknowledgement.
M9 previously refused to claim `RECEIVED`, so all BullMQ attempts could exhaust
before the processing lease incremented, after which the generic dead-letter
fallback persisted `unexpected` / `webhook-processing-failed` with attempt count
zero. The worker now atomically claims the published `RECEIVED` window as well
as `QUEUED` and expired `PROCESSING`. Sanitized full `order.created` and ID-only
`order.deleted` regressions pass without changing payload handling, M13 delivery,
or M18 settings policy.

Commit `892fc925` was deployed with the backend and telegram bot. The final
newly created order after re-enabling `ORDER_CREATED` produced exactly one
Telegram notification in under one second, and its newest `order.created`
WebhookEvent completed with `processing_attempt_count = 1`. The production
defect fix is complete and has no remaining deployment or validation item.

Migration `20260723180000_order_projection` applied cleanly in an isolated
PostgreSQL database. D-018 records projection ordering, canonical fingerprint,
lease recovery, reconciliation, and verified delete/restore boundaries.

---

Plugin

WordPress connector 0.2.2 exposes a minimal WooCommerce admin page that
accepts exactly one M7 token. It derives Store identity only from the M7
response, stores required connector/webhook material with WordPress autoload
disabled, never re-renders secrets, creates or updates the four required order
webhooks, verifies their active topic/destination state, and calls the
plugin-credential-authenticated connection-health operation. Safe retry and
new-token reconnect guidance are included; no SaaS credentials, tenant/Store
selection, order logic, or business policy is present.

The final connector corrects WooCommerce's proxied `WC_Data_Store` webhook
loader behavior, safely reconciles duplicate connector-owned canonical hooks,
restores the persisted M8 secret during Retry, and keeps Retry idempotent. A
dedicated direct HTTPS connector origin supports restricted/Iran-hosted network
conditions without changing the browser onboarding origin or exposing new
services.

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
verification pass. The deployed M16 fresh-merchant validation exercised public
registration/login successfully on the VPS.

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
Ineligible direct API calls fail before token persistence. Redemption now also
revalidates that eligibility and permits only an explicitly unlinked stale
pilot Telegram identity to bind to the new self-service User; active identity
conflicts, expired tokens, malformed tokens, and replay remain rejected. M12-V
remains functional by recording its already-verified pilot Store health when it
activates that Store.

M16 adds no schema migration or dependency. Backend tests pass at 262 and
bot tests remain at 32. Build, typecheck, lint, formatting, Prisma
validate/generate, connector contract checks, and diff checks pass.

Final A validation passed the complete fresh-merchant onboarding path through
public account creation, M3 Tenant/OWNER bootstrap, Store validation, M7
registration, Store activation, independent connector health, and exactly four
canonical order webhooks. Retry recovery and duplicate reconciliation passed;
old private-pilot hooks were removed. A real signed M8 `order.created` delivery
was accepted with HTTP 200. Fresh M10 linking, `/status`, `/orders`, order
detail, Back/Home navigation, and one-time token replay rejection all passed.
B returned MERGE. The merged `main` revision was deployed and `/api/health`
passed its production smoke test.

M17 completes the approved MVP order workflow without replacing M6, M9, or the
M11–M16 Telegram foundations. `/order <number>` performs one case-sensitive
exact match against the current backend-resolved tenant and Store projection;
malformed, missing, duplicate-exact, unauthorized, no-context, deleted, and
stale-reference outcomes fail safely. OWNER, ADMIN, and MEMBER may read.

Active order detail now issues the existing signed M11 detail reference for a
bounded Refresh action. Refresh re-resolves current Telegram authorization,
loads the referenced current-Store Order, performs one logical M6 authoritative
single-order read with the established safe read retries, and passes the payload
only through M9 `reconcileAuthoritativeOrder`. It adds no polling, queue, sync
service, or alternate projection path.

OWNER and ADMIN receive an Add Note capability; MEMBER receives neither the
button nor backend permission. Internal and customer-visible choices map to
WooCommerce `customer_note=false` and `customer_note=true`. The bot remains
stateless: a short-lived context-bound backend reference is embedded in a
Telegram ForceReply prompt, and the backend validates bounded plain text before
returning a safe preview plus mandatory Confirm/Cancel actions.

The M17 migration extends the existing Order projection with only
`payment_snapshot` and `shipping_lines_snapshot`, and adds encrypted short-lived
note draft fields plus the narrow `TelegramOrderNoteAction` durable claim/result
record. Confirm atomically claims the reference and action, performs a safe
authoritative existence read, then dispatches the WooCommerce note POST once
without write retry. Success, definitive failure, ambiguous/lost response, and
replay are persisted; stale in-flight claims become ambiguous and are never
redispatched. Successful creation emits `telegram.order.note.created` with
Store, visibility, and result metadata only. Note text is absent from action
records, AuditLog, and structured logs; the short-lived required draft copy is
encrypted and cleared on completion or cancellation.

Order detail exposes payment method/title plus paid/unpaid state, and shipping
method plus minimized fulfillment address lines. It deliberately omits
transaction IDs, phone, email, credentials, and raw WooCommerce payloads. No
Customer, Payment, Shipping, or note-history model was introduced.

M17 automated evidence passes: Prisma validate/generate, 48 backend suites with
292 tests, 39 Telegram bot tests, build, typecheck, lint, formatting, and diff
checks. The full 11-migration chain, including M17, applied cleanly to an
isolated PostgreSQL 16 database and Prisma reported the schema up to date.

M17 received B review `MERGE`. Production migration
`20260830120000_m17_order_workflow_completion` was successfully applied, and
backend plus telegram-bot deployment passed. Production `/api/health` and
`/api/health/readiness` passed. On the real Store, `/order <known-test-order>`,
authoritative Refresh, internal WooCommerce note round-trip, and
customer-visible WooCommerce note round-trip all passed. No additional live
duplicate, MEMBER, cross-tenant, or ambiguous-response testing was required;
those cases were accepted from automated/adversarial coverage. M17 operational
validation passed and M17 is fully closed.

M18 adds Tenant-owned `timezone` and `language` directly to the existing Tenant
model. Timezone accepts canonical IANA-style identifiers through the Node 20
`Intl` runtime, including `UTC` and `Asia/Tehran`, without a dependency.
Language is the typed `TenantLanguage` enum with exactly `FA` and `EN`, mapped
to persisted `fa` and `en` codes.

Store now owns nullable `lowStockThreshold`, the exact
`ORDER_CREATED`/`LOW_STOCK` category array, and
`NotificationRecipientMode.ALL_ELIGIBLE` or `SELECTED`. The migration backfills
existing Tenants to `UTC`/English and existing Stores to `ORDER_CREATED`,
`ALL_ELIGIBLE`, and an unset threshold. Future Tenants default to Persian and
`UTC`; no timezone is inferred.

`StoreNotificationRecipient` selects a Membership through composite
Store+Tenant and Membership+Tenant foreign keys plus Store+Membership
uniqueness. It stores no Telegram identity. Inactive or unlinked selected
Memberships remain configured but cannot receive delivery; a legitimate relink
of the same Membership restores future eligibility through current M10 state.

The backend-only Telegram settings service re-resolves account, private chat,
active Membership/role, Tenant, and exact-one active Store for every request.
OWNER and ADMIN receive absolute set/select/remove actions; MEMBER receives the
same summary without mutation references and is denied by backend policy if a
mutation endpoint is called manually. Settings references are short-lived,
opaque, HMAC-authenticated, and account/chat/Tenant/Store bound. Timezone and
threshold next-message contexts are stored only in the backend and consumed on
successful application; the bot owns no session or Prisma state.

M13 remains unchanged except for Store policy filtering. Scheduling requires
`ORDER_CREATED` to be enabled. `ALL_ELIGIBLE` retains the existing recipient
set; `SELECTED` intersects it with configured Memberships and an empty selected
set sends to nobody. Pre-dispatch preparation revalidates category, mode,
selected Membership, and all existing M10 authorization/context rules before
the existing state machine and transport can send. Delivered history is not
deleted or resent.

Every successful logical mutation creates one safe
`telegram.settings.updated` AuditLog record. Absolute no-op replays do not add
duplicate audit rows. Recipient audit metadata contains action/count/result
state only, not email, Telegram/chat identity, raw Membership identity, or user
input.

Migration `20260831120000_m18_store_settings_foundation` passed the complete
12-migration chain on isolated PostgreSQL 16 and Prisma reported the schema up
to date. Seeded pre-M18 rows verified English/UTC and legacy Store backfill;
new rows verified Persian/UTC defaults. Database checks rejected negative
thresholds, duplicate or null notification categories, duplicate recipients,
and cross-tenant recipient mappings. The final adversarial audit found and
closed the one concrete storage defect: PostgreSQL enum typing rejected unknown
category values but did not itself reject duplicate enum-array members. The M18
migration now enforces a duplicate-free, null-free subset of the two categories.

Automated evidence passes: 332 Jest backend tests, 24 backend Node
smoke/contract tests with one environment-only PHP skip, and 45 Telegram bot
tests. Real isolated-database probes additionally verified concurrent duplicate
category enable, duplicate recipient selection, opposing desired states, stale
single-use input, MEMBER replay denial, safe audit counts, and database-level
recipient isolation. Prisma format/validate/generate, build, typecheck, lint,
format, and diff checks pass. M18 adds no dependency and no inventory, low-stock
processing, search, reporting, general localization, billing, dashboard, Store
switching, connector behavior, queue, or new service topology. D-024 remains
Accepted and unchanged.

M18 production validation passed: migration application; backend plus
telegram-bot deployment; `/api/health`; `/api/health/readiness`; `/settings`;
settings and timezone persistence; enabled `ORDER_CREATED` delivery; View Order
from the notification; disabled-category suppression; and no historical resend
after re-enabling. The final newly created order after re-enable produced
exactly one Telegram notification in under one second, with the newest
`order.created` processed as `COMPLETED` on one processing attempt. This same
combined live validation closes the previously pending deployed M13 synthetic-
notification validation as PASS. M18 is fully complete and operationally
validated.

M19 adds a narrow `InventoryItem` projection keyed by Store and WooCommerce
stock-bearing item ID. It persists only minimized product/variation display
context, SKU, stock ownership, quantity/status, WooCommerce modification time,
fingerprint, synchronization/deletion state, current classification, and alert
incident generation. WooCommerce remains authoritative and WCTM exposes no
inventory mutation path.

Store inventory begins `UNINITIALIZED`. The first `/stock` request or an
enabled `LOW_STOCK` category automatically starts a current-state bootstrap on
the existing `operations` queue. Each deterministic revision reads one bounded
25-row product or variation page, persists progress, resumes after retry or
restart, and marks `READY` only after all pages complete. Bootstrap establishes
a no-alert baseline. `/stock` returns `SYNCING` or recoverable `SYNC_FAILED`
rather than exposing a partial projection.

The connector now reconciles the existing four order topics plus exactly
`product.created`, `product.updated`, `product.deleted`, and
`product.restored`, using the existing M8 endpoint key and HMAC secret. M8 raw
authentication, Store/delivery deduplication, server-derived Store identity,
queue topology, M9 Order routing, M10 linking eligibility, and M16 ACTIVE/health
semantics remain unchanged. Product events route only to the M19 projector.

Projection follows stock ownership: managed products or variable parents are
one physical pool; independently managed variations are separate items with
bounded parent/attribute context; parent-inheriting variations are not separate
items. An unmanaged product or variation that does not inherit a parent pool may
still represent WooCommerce's explicit `outofstock` state. Modification time
plus fingerprint prevents stale
or duplicate regression, equal conflicts use one authoritative item read, and
an equal-time bootstrap response cannot overwrite a webhook projection.
Deletion deactivates without notification; restore reprojects current identity.

Classification is exact: WooCommerce `outofstock` is always `OUT_OF_STOCK`;
otherwise a managed numeric quantity at or below non-null
`Store.lowStockThreshold` is `LOW_STOCK`; everything else is `HEALTHY`. A null
threshold never creates quantitative WCTM low stock but still shows explicit
out-of-stock items. M18 threshold changes rebaseline projected classification
and clear alert sources without scheduling notifications.

Each item owns a durable incident generation and separate LOW/OUT source
capture. HEALTHY→LOW or HEALTHY→OUT may schedule one level per current
recipient; LOW→OUT may schedule one escalation; repeated LOW/OUT and OUT→LOW
schedule nothing new; HEALTHY closes and rearms without a back-in-stock
message. A dedicated delivery relation is unique by item, generation, alert
level, and chat authorization. It reuses the existing queue and prepared bot
transport with delivered/retryable/terminal/ambiguous outcomes and no blind
resend.

Scheduling requires M18 `LOW_STOCK`. `ALL_ELIGIBLE` uses the current M10
manager set, while `SELECTED` is a strict intersection and zero selected means
zero delivery. Recipients are captured once per incident level, so later
category or recipient changes cannot resurrect old alerts. Pre-dispatch checks
repeat the captured Store policy generation, policy, Membership, account,
private-chat authorization generation, Tenant/Store context, incident
generation, and current classification.

The stateless bot adds read-only `/stock` for OWNER, ADMIN, and MEMBER. The
backend re-resolves exact current context, returns OUT then LOW items in
eight-row pages within a 200-row window, and provides minimized item detail.
Pagination and detail callbacks use short-lived account/chat/Tenant/Store-bound
signed references; callback data contains no raw Tenant, Store, Membership, or
WooCommerce item ID. No stock adjustment or other mutation exists.

Migration `20260901120000_m19_inventory_low_stock` passes the complete
13-migration chain on isolated PostgreSQL 16, and Prisma reports the database up
to date. A representative pre-M19 Store with `LOW_STOCK` enabled backfilled to
`UNINITIALIZED`, product page 1, variation page 1, revision 0, with zero
inventory rows and zero deliveries. Transactional constraints reject duplicate
Store/WooCommerce identity, cross-Tenant Store ownership, invalid stock shape,
and duplicate incident-level recipient delivery. M19 adds no dependency and no
new schema drift; only previously recorded name-only drift remains.

Focused automated coverage includes bootstrap continuation/failure,
product-event authentication/deduplication/routing, stock ownership and
variation cases, stale/equal/duplicate projection, threshold boundaries/null,
incident escalation/recovery/rearm, policy and authorization suppression,
durable replay/ambiguity, `/stock` authorization/pagination/detail/reference
tampering, connector reconciliation, and M8/M9/M13/M18 regressions. Prisma
format/validate/generate, full tests, build, typecheck, lint, formatting, diff,
and isolated database gates pass. D-025 is Accepted.

M19 production migration/deployment and the controlled real-Store
validation passed. Migration `20260901120000_m19_inventory_low_stock` and
corrective migration `20260901190000_m19_nullable_managed_stock_quantity` were
applied successfully. Backend, telegram-bot, and updated connector deployments
passed, as did native PHP lint, connector Retry/reconciliation, `/api/health`,
`/api/health/readiness`, onboarding connection health, and exactly eight active
canonical webhooks: the four order topics plus `product.created`,
`product.updated`, `product.deleted`, and `product.restored`.

The first `/stock` triggered the bounded current-state bootstrap and the Store
reached `READY` without historical LOW/OUT notifications. `/stock`, signed item
buttons/detail, current LOW/OUT projection, explicit out-of-stock with a null
WCTM threshold, valid managed-stock/null-quantity input, and display fallback to
`Unnamed variation` all passed against the production Store.

With threshold 5, `LOW_STOCK` and `ORDER_CREATED` enabled,
`ALL_ELIGIBLE`, and the authorized manager eligible, the controlled lifecycle
passed: 10→5 projected LOW and delivered exactly one LOW notification; 5→4 did
not duplicate; 4→0 projected OUT and delivered exactly one OUT escalation; 0→9
rearmed without a back-in-stock notification; and 9→0 created a new incident
with exactly one new OUT notification. OUT deliveries for incident generations
4 and 5 are `DELIVERED`, with immediate completed attempts. Older pre-hotfix
`bot-request-rejected` rows remain terminal and were not blindly replayed.

Material M19 production corrections are `8f13fd3` plus corrective migration
`20260901190000_m19_nullable_managed_stock_quantity` for managed-null stock,
`00f4f4c` for safe Woo name→SKU→unnamed display fallback without weakening Woo
identity, `242d72a` for PostgreSQL numeric threshold bind typing with
transactional rollback; the null→5 threshold then persisted with the Store
remaining `READY` and no retroactive notification. `ef0957b` permits signed
`v.` View Stock callbacks on the private delivery endpoint. The
pre-existing M8/M9 publication race fixed in `892fc925` remains recorded
separately. M19 is fully complete and operationally validated; D-025 remains
Accepted.

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

main

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

M21 has no known implementation blocker. B review, merge, deployment, and live
validation are intentionally outstanding. Existing known issues and technical
debt remain unchanged.

---

Next Milestone

Complete B review, merge, deployment, and production validation for M21 under
D-027. Do not begin M22.

---

Last Completed

M20 Search & Daily Report is fully complete, merged, deployed, hotfixed, and
operationally validated. Final decision: PASS.

---

Project Health

Excellent

---

Last Updated

2026-09-03

---

M21 Implementation State

- D-027 is Accepted. `Tenant.language` is authoritative; resolved `FA` renders
  Persian, resolved `EN` renders English, Telegram `language_code` is ignored,
  pre-Tenant/unlinked UX defaults to Persian, and unknown runtime language
  falls back to English.
- The telegram-bot owns one typed `fa`/`en` catalog with exact key-parity tests,
  bounded named interpolation, safe missing-key recovery, semantic label maps,
  Tenant-timezone `Intl` date/calendar formatting, exact currency preservation,
  and Unicode FSI/PDI isolation for LTR identifiers.
- Backend Telegram operations append one small authoritative presentation
  envelope after the existing operation. `/settings` language mutation resolves
  that envelope after the mutation, so the returned screen and private-chat
  native command descriptions switch immediately.
- All existing M10–M20 manager Telegram commands, callbacks, navigation,
  normal/empty/success/failure/recovery states, order/note/status flows,
  settings and recipients, inventory, search, and report presentation now use
  the catalog. M16 onboarding, public web surfaces, and the connector are
  unchanged.
- M13 ORDER_CREATED and M19 LOW/OUT prepared delivery now carry sanitized
  semantic data, resolved Tenant presentation metadata, and the same authorized
  signed references to the bot for final localized rendering. Delivery rows,
  identity, queue jobs, claims, retries, terminal/ambiguous handling,
  no-blind-resend behavior, categories, and recipient selection policy are
  unchanged.
- No Prisma schema, migration, dependency, service/process topology, queue,
  scheduler, template platform, notification category, or M22 capability was
  added.
- Local implementation gates pass. Production validation remains pending until
  B review and merge; M21 is not operationally closed.

---

M20 Closure State

- D-026 is Accepted. `/search <query>` reads only current Store Order and READY
  InventoryItem projections for exact/prefix Order number, projected customer
  display name, SKU, and inventory display name. Email, phone, standalone
  Customer search, live Woo reads, fuzzy/semantic search, and generic catalog
  behavior are absent.
- Search uses deterministic ranking and stable tie-breakers, eight rows per
  page, a 200-result reachability cap, encrypted short-lived query state, and
  signed result/page references bound to current account, private chat,
  Membership, Tenant, and Store. Exact unique Order numbers reuse native M17
  detail/actions; inventory results reuse minimized M19 detail and may include
  HEALTHY items. Non-READY inventory produces an explicit partial-search state.
- On-demand `/report` computes the Tenant-local civil day with DST-safe IANA
  timezone conversion and queries `wc_created_at` by UTC half-open boundaries.
  It reports Orders created today, current status distribution, processing plus
  completed gross operational sales and AOV separated by exact currency, and
  current LOW/OUT counts only when inventory is READY. It surfaces delayed
  projection state and makes no accounting-completeness claim.
- Migration `20260903120000_m20_search_daily_report` adds only bounded
  projection-search/report indexes and privacy-protected short-lived search
  references. It adds no Customer, Product, report, analytics, scheduler,
  delivery, or snapshot model and performs no behavioral backfill.
- Focused backend/Telegram tests cover exact and ambiguous Order behavior,
  short-query handling, encrypted reference state, currency/status revenue
  semantics, inventory readiness, UTC/non-UTC/DST day boundaries, privacy, and
  Telegram rendering. Full repository gates are recorded at handoff.
- Final implementation merge `0281bb0` and hotfix merge `4b66c9a` are on
  `main`. Production applied `20260903120000_m20_search_daily_report`, reported
  all 15 migrations current, deployed backend and telegram-bot, passed health
  and readiness with clean startup/runtime logs, and loaded the search/select
  and report routes.
- Real-Store validation passed exact Order lookup with native M17 detail,
  customer-name and inventory-name prefix search, inventory result/detail, safe
  empty search, `/order`, and `/stock`.
- Numeric SKU `312` exposed a production defect because discovery depended only
  on the heterogeneous raw-SQL text predicate. Hotfix
  `c38af6edb2758c8c3f7b5b5a7b696fbf9a658827` performs a typed,
  Store/Tenant-scoped exact-SKU lookup after a numeric query fails to resolve a
  unique exact Order, then re-enters global ranking at exact-SKU rank 2. Unique
  exact Order remains rank 1 and ranking, pagination, prefix, and reference
  semantics are unchanged. The backend-only deployment and `/search 312`
  production retest passed.
- SKU `604` is present in the current InventoryItem projection and searchable;
  SKU `903` has no current Store InventoryItem row. M20 searches the M19
  projection, not the complete WooCommerce catalog, so this is a non-blocking
  production-data/projection limitation and not current proof of an M19 or M20
  defect. Revisit post-MVP only after a reproducible real-Store WCTM projection
  defect.
- The on-demand report passed for `Asia/Tehran` on 2026-09-03: zero Orders, no
  gross operational sales or status distribution, two LOW and 101 OUT items,
  delayed-projection warning, and projected-operational/non-accounting
  disclaimer. No scheduled delivery occurred. M20 final decision: PASS.
