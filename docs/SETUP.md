# Local Development Setup

The complete WC-Telegram-SaaS scaffold can run locally in under five minutes.

## Prerequisites

- Docker Desktop, Docker Engine, or an equivalent container runtime
- Docker Compose v2 (`docker compose version`)
- Git
- Optional for host-based TypeScript development: Node.js 20+ and npm 10+

No local PostgreSQL, Redis, Caddy, WordPress core, or global NestJS CLI is
required.

## 1. Clone and Configure

```bash
git clone <repository-url> wc-telegram-saas
cd wc-telegram-saas
cp .env.example .env
```

The values in `.env.example` are local placeholders. Before any shared or
production deployment, replace all passwords, tokens, encryption keys, and
webhook secrets with cryptographically secure values.

The backend loads root `.env` values through its global
`ApplicationConfigModule`. Application code consumes typed settings from
`ApplicationConfigService`; it must not read `process.env` directly. Development
provides defaults only for non-secret settings such as `PORT`, `LOG_LEVEL`, and
`REDIS_URL`. Test mode supplies isolated placeholders. Production requires every
canonical application value and rejects the documented development placeholders.

`APP_ENCRYPTION_KEY` must be standard base64 encoding of exactly 32 bytes.
`JWT_ACCESS_TTL` controls the access-token lifetime using a duration such as
`15m` and is required in every environment.
Configuration validation reports all invalid variable names together without
including their values.

Public account authentication is available through `POST /api/auth/register`
and `POST /api/auth/login`. Both accept only `email` and `password`; emails are
trimmed and lowercased consistently, and passwords must contain 12–128
characters. Registration persists an Argon2id hash and both operations return
the existing access-token format plus the safe User profile. The token contains
only the User subject until the client uses the existing authenticated
`POST /api/tenants` bootstrap; registration and login do not create a Tenant,
Membership, Store, or active tenant context.

M16 adds authenticated `POST /api/auth/tenant-context`. The request body carries
no Tenant or Store ID. Using only the JWT subject, it asks the merchant to use
the existing `POST /api/tenants` M3 bootstrap when no active Membership exists,
returns the existing access-token response with the sole legitimate tenant
context when exactly one exists, and refuses multiple Memberships because
tenant selection is outside M16. The public onboarding ceremony is available
at `/onboarding` through Caddy.

The two public endpoints use independent endpoint-scoped Redis fixed windows.
Registration defaults to 5 attempts per 60 seconds through
`AUTH_REGISTER_RATE_LIMIT` and `AUTH_REGISTER_RATE_WINDOW_SECONDS`; login
defaults to 10 attempts per 60 seconds through `AUTH_LOGIN_RATE_LIMIT` and
`AUTH_LOGIN_RATE_WINDOW_SECONDS`. Keys contain hashed IP and normalized-email
components, not raw credentials. Redis failure closes the endpoint safely.

The Telegram transport and backend share `BOT_INTERNAL_API_KEY` as a dedicated
service credential. Generate a strong random value outside local development;
never reuse the Telegram bot token or a user JWT. `BACKEND_INTERNAL_URL` is the
backend API base URL used only by the bot (the Compose default is
`http://backend:3000/api`). `BOT_INTERNAL_URL` is the private bot transport base
URL used only by the backend (the Compose default is
`http://telegram-bot:3001`), and `BOT_INTERNAL_PORT` selects that bot listener.
The bot listener has no published host port and no Caddy route. Prepared-message
requests use the bounded `BOT_DELIVERY_TIMEOUT_MS`, which defaults to 10,000ms;
an unconfirmed response is treated as ambiguous and is not blindly resent.
Telegram account-link tokens default to a 900-second lifetime through
`TELEGRAM_LINK_TOKEN_TTL_SECONDS`.
M11 callback data uses a dedicated `TELEGRAM_CALLBACK_SIGNING_KEY` (minimum 32
characters), with reference lifetime controlled by
`TELEGRAM_CALLBACK_REF_TTL_SECONDS`. Projected-order freshness is considered
delayed after `TELEGRAM_ORDER_FRESHNESS_THRESHOLD_SECONDS`. The bot-to-backend
deadline for read-only and short operations is configured through
`BOT_BACKEND_TIMEOUT_MS` and defaults to 5,000ms. M12 order-status writes alone
use `BOT_STATUS_WRITE_TIMEOUT_MS`, which defaults to 50,000ms. That bounded
deadline covers an authoritative read, one WooCommerce write, and a possible
lost-response reconciliation read at the existing 15,000ms hard operation cap,
plus 5,000ms for projection, audit, database, and HTTP processing. It does not
add a backend request retry or a WooCommerce write retry.

WooCommerce REST credential validation defaults to three total attempts, a
5,000ms timeout per attempt, and a 15,000ms hard operation cap. Retry delays use
a 300ms exponential base, factor 2, and jitter ratio `0.2` (±20%). These values
are exposed through the typed `WOOCOMMERCE_REST_*` settings in `.env.example`.
Only timeouts, transport failures, HTTP 429, and HTTP 5xx are retried.

Plugin registration tokens default to a 900-second lifetime. Public
`POST /api/plugin/register` requests use a Redis fixed window of 10 attempts per
60 seconds, scoped by client IP and registration-token hash prefix. Configure
these limits with `PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS`,
`PLUGIN_REGISTRATION_RATE_LIMIT`, and
`PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS`. This limiter is endpoint-scoped and
does not install a global throttling guard.

Migration `20260828120000_public_account_authentication` adds only nullable
`users.password_hash`, so existing pilot/operator-created Users remain valid
and simply cannot use password login. Before adding the column, the migration
refuses to proceed if existing User emails collide after trim-and-lowercase
normalization. It never rewrites existing emails; resolve any reported
collision with A before retrying the migration.

The Telegram bot now starts grammY long-polling. A real `TELEGRAM_BOT_TOKEN` is
required to run the bot transport; the documented placeholder remains suitable
only for configuration validation and backend-only development.

## Private-Pilot M12 Validation Bootstrap

M12-V provides exactly two supported operator commands:

```bash
npm run pilot:setup
npm run pilot:readiness
```

They are private-pilot validation tools. They are not public onboarding, a
WordPress connector UI, billing, or a general account-administration surface.
They support exactly one pilot User, one Tenant, one OWNER Membership, and one
Store.

Configure the backend container before running either command:

```dotenv
PILOT_MODE=true
PILOT_WEBHOOK_BASE_URL=https://pilot-api.example.com
PILOT_READINESS_TIMEOUT_SECONDS=60
```

`PILOT_MODE=true` is an explicit safety gate. With the flag absent or false,
both commands refuse to run. `PILOT_WEBHOOK_BASE_URL` must be the approved
public HTTPS origin served by Caddy. Localhost, private IP addresses, plain
HTTP, URL paths, and tunnels are rejected.

The validation topology is:

```text
Internet → Caddy :443 → backend /api/*
```

Only Caddy publishes HTTP/HTTPS. PostgreSQL, Redis, the backend container port,
and other internal services remain on the Compose network and must not be
published publicly. Real WooCommerce cannot deliver webhooks to localhost; do
not substitute a tunnel.

After deploying or rebuilding the backend on the approved VPS, run the commands
inside the backend container so they use its typed configuration and private
network database connection:

```bash
docker compose exec backend npm run pilot:setup
```

The setup command:

1. refuses unrelated existing User/Tenant bootstrap data;
2. atomically creates the first User, Tenant, and OWNER Membership, or reuses
   the exact same sole pilot identity;
3. issues an access token through `AuthService` and keeps it in memory;
4. prompts for the WooCommerce Store URL and REST credentials, with both
   credential values hidden from terminal echo;
5. validates and encrypts the Store credentials, provisions the dedicated
   webhook secret and endpoint key, and registers the four required order plus
   four required product webhooks at the public Caddy route;
6. prints the one-time `/start <token>` string for the private Telegram bot
   chat.

No JWT, SQL, curl request, Store ID, webhook secret, bot API key, or manual API
payload is required from the operator. A completed re-run is a no-op for the
same identity and reuses the encrypted Store configuration. There is no
`--force`, reset, overwrite, delete, or teardown option.

After pasting the `/start` command into the private bot chat, create one clearly
marked synthetic order in WooCommerce admin. Use no real payment or customer
and keep it in a non-terminal status. Order creation is intentionally manual.
Then run:

```bash
docker compose exec backend npm run pilot:readiness
```

Readiness prints nine PASS/FAIL checks without identifiers or secrets and waits
up to `PILOT_READINESS_TIMEOUT_SECONDS` for the synthetic webhook projection.
It exits non-zero with one actionable recovery message if any check fails and
exits zero only when the projected order is available to the Telegram order
flow. It is safe to rerun.

## 2. Start the Docker Stack

```bash
docker compose up --build
```

Docker Compose starts:

1. PostgreSQL 16 and Redis 7 with persistent named volumes.
2. The NestJS backend after both data services pass health checks.
3. The grammY bot transport, which calls the backend internal Telegram API.

Caddy is not a Compose service in the current repository. Local development
reaches the loopback-published backend directly. Production uses the existing
host-level Caddy topology documented below.

Expected application log messages include:

```text
NestJS application started on port 3000
{"event":"telegram_bot_polling_started",...}
```

## 3. Verify Services

In another terminal:

```bash
docker compose ps
curl --fail "http://127.0.0.1:${PORT:-3000}/api/health"
docker compose exec postgres pg_isready \
  -U "$(awk -F= '/^POSTGRES_USER=/{print $2}' .env)" \
  -d "$(awk -F= '/^POSTGRES_DB=/{print $2}' .env)"
docker compose exec redis redis-cli ping
```

The health response is `{"status":"ok"}`.

The backend also exposes a public dependency-readiness probe:

```bash
curl --fail http://localhost/api/health/readiness
```

When PostgreSQL and Redis are both available, it returns:

```json
{ "status": "ready", "dependencies": { "postgres": "up", "redis": "up" } }
```

The endpoint returns HTTP 503 when either dependency is unavailable. Use
`/api/health` for process liveness and `/api/health/readiness` before routing
traffic.

Redis returns `PONG`, and PostgreSQL reports that it accepts connections.

`CADDY_DOMAIN=http://localhost` is for manually running the repository Caddy
example in local development. The shared VPS does not run Caddy from Compose.

## Host-Based TypeScript Workflow

```bash
npm install
npm run prisma:validate --workspace backend
npm run prisma:generate --workspace backend
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Use `npm run format` to apply Prettier formatting.

## Tenant Entitlement Operations

M22 service access is authoritative only from the current Tenant row in
PostgreSQL. Existing `Tenant.plan` values (`FREE`, `PRO`, `AGENCY`) are
informational and receive the same MVP capability bundle. Persisted status is
only `ACTIVE` or `SUSPENDED`; `EXPIRED` is derived when an ACTIVE Tenant reaches
its nullable UTC expiry. New and migrated Tenants are ACTIVE with no expiry.

Use the backend application-context operator command from a trusted shell with
the normal backend environment and database connectivity. It always requires
one explicit Tenant identifier. Build the current backend first with
`npm run build` when the compiled `dist/` tree is not already present:

```bash
# Inspect current plan, persisted status, effective state, and expiry.
npm run entitlement:manage -- --tenant ten_example

# Suspend or reactivate. ACTIVE does not clear an existing expiry.
npm run entitlement:manage -- --tenant ten_example --status SUSPENDED
npm run entitlement:manage -- --tenant ten_example --status ACTIVE

# Set an explicit UTC expiry or restore indefinite access.
npm run entitlement:manage -- --tenant ten_example --expires-at 2026-10-01T00:00:00Z
npm run entitlement:manage -- --tenant ten_example --clear-expiry

# Status and expiry may be changed atomically.
npm run entitlement:manage -- --tenant ten_example --status ACTIVE --expires-at 2026-10-01T00:00:00Z
```

The command rejects missing/deleted Tenants, invalid status or timestamp input,
unknown options, and contradictory expiry options. Its output contains only a
Tenant fingerprint, plan, persisted/effective state, and expiry. Mutations add a
system/operator AuditLog entry and a structured secret-safe event. Never pass a
customer name, email, Telegram identity, Store secret, plugin credential, or
raw payload in place of the Tenant identifier.

Inactive access preserves login, account and recovery/status surfaces,
read-only settings, existing Store/link/plugin/webhook state, and authenticated
webhook projection continuity. It blocks operational Telegram capabilities,
normal Store onboarding, M7/M10 issuance/finalization/redemption, settings
mutation, and new or pending notification dispatch. Reactivation restores only
future eligible work; it does not replay historical notification or callback
state. Entitlement is not a JWT, Redis, Telegram, WooCommerce, or connector
setting.

## Queue and Worker Operations

Outside `NODE_ENV=test`, the NestJS backend starts one BullMQ `operations`
queue worker in-process. No separate worker command or container is required for
M5. The reference producer is an internal injectable foundation; M5 intentionally
adds no public enqueue endpoint or business job.

Reference jobs carry a server-derived tenant ID and an optional Store ID. They
use three total attempts with exponential backoff starting at one second.
Exhausted jobs remain in BullMQ's failed set and produce a structured backend
error log without raw payload or exception contents.

Useful local checks:

```bash
docker compose logs -f backend redis
curl --fail http://localhost/api/health
curl --fail http://localhost/api/health/readiness
docker compose stop backend
```

`docker compose stop backend` sends SIGTERM. Nest waits for active worker work,
then closes worker and queue connections. Use this graceful path instead of
force-killing the process.

For production, provide a protected `REDIS_URL`, require readiness success
before accepting traffic, monitor terminal job-failure log events, and allow the
backend process enough shutdown time to finish active work. M5 does not add a
replay endpoint, scheduler, dead-letter service, or business queue.

M19 reuses this same `operations` queue for one-time current-inventory
initialization. The first `/stock` request for an uninitialized Store, or
enabling the M18 `LOW_STOCK` category, schedules a deterministic bootstrap.
Each job reads at most one bounded 25-row WooCommerce product or variation page
and persists the next cursor before scheduling its continuation. Retry resumes
from persisted progress; no operator-created SQL/JWT job, periodic polling,
separate worker, queue, or scheduler is required. `/stock` reports `SYNCING` or
a recoverable failure until the full current snapshot is `READY`, and bootstrap
never sends historical low-stock notifications.

## Database Migrations

The PostgreSQL schema is defined in `backend/prisma/schema.prisma`. Versioned
migrations are stored in `backend/prisma/migrations/`.

Apply committed migrations from CI or another environment that has workspace
dependencies installed and can reach PostgreSQL:

```bash
npm run prisma:migrate:deploy --workspace backend
```

For future schema changes during local development:

```bash
npm run prisma:migrate:dev --workspace backend -- --name <migration-name>
```

Run migration commands from the host only when `DATABASE_URL` points to a
database address reachable from the host. The default Docker value uses the
internal hostname `postgres`; override it with the appropriate reachable
database URL when running Prisma outside the Compose network.

## WordPress Plugin

WordPress core is intentionally excluded from this repository. The production
M16 connector is stored under `wp-content/plugins/`. To validate it in a local
WordPress environment:

1. Copy the connector files from this repository's `wp-content/plugins/` into
   the WordPress installation's `wp-content/plugins/wc-telegram-connector/`
   directory.
2. Install and activate WooCommerce.
3. Configure `WC_TELEGRAM_CONNECTOR_API_BASE_URL` as the connector's public
   WCTM HTTPS origin in the connector build or `wp-config.php`. The value must
   be an HTTPS origin with no credentials, query, or fragment. Production
   currently uses:

   ```php
   define(
       'WC_TELEGRAM_CONNECTOR_API_BASE_URL',
       'https://connector.wctm.walterbyte.com'
   );
   ```

4. Run `php -l wc-telegram-connector.php`, then activate **WC Telegram
   Connector** from the Plugins screen.
5. Complete account, Tenant, and Store creation at `/onboarding`, issue one M7
   token, then paste only that token into WooCommerce → WCTM Connector.

Without WooCommerce, the plugin still activates safely and displays an
administrator notice. A successful fresh M7 response provides
`pluginCredential`, `storeId`, `webhookSecret`, and `webhookEndpointKey` once.
The connector stores required material with autoload disabled, installs and
verifies the four required order webhooks plus `product.created`,
`product.updated`, `product.deleted`, and `product.restored`, and then confirms
backend health. The existing Retry/reconciliation path adds missing product
hooks to connected Stores without rotating credentials or retaining duplicate
canonical hooks. Product hooks use the same endpoint key and HMAC secret; no
inventory business rule runs in PHP.
M7 registration promotes the Store from `PENDING` to `ACTIVE`, but M10
link-token issuance remains forbidden until connector confirmation succeeds and
backend verification records healthy order-webhook evidence. M19 does not make
M10 eligibility or M16 Store health depend on the product-hook set.

The production connector hostname is DNS-only because some Iran-hosted
WooCommerce environments cannot reach the Cloudflare-proxied public application
hostname. Browser onboarding can remain at `https://wctm.walterbyte.com`; this
is an operational network constraint and does not change the M7 registration or
M8 endpoint-key plus HMAC architecture. Do not place a token, credential,
secret, or other sensitive value in the hostname or this constant.

`https://connector.wctm.walterbyte.com` reaches the existing backend through
Caddy. Direct-origin connector routing does not publish PostgreSQL or Redis and
does not expose any additional backend, database, cache, or bot ports.

## Common Commands

```bash
docker compose logs -f backend telegram-bot
docker compose restart backend telegram-bot
docker compose down
docker compose down --volumes
```

`docker compose down --volumes` permanently deletes local database, Redis, and
Caddy state. It is prohibited for the M12-V private-pilot workflow, which has no
destructive teardown.

Production VPS uses host-level Caddy.

WCTM backend is bound to 127.0.0.1:${PORT}.
Host Caddy terminates HTTPS and reverse-proxies
wctm.walterbyte.com to localhost:${PORT}.

The Docker Compose Caddy service is not used on the shared VPS.

## Production Security Baseline (P7.1)

P7.1 changes repository configuration and runbooks only. It does not authorize
SSH access, firewall/sshd/Caddy changes, credential rotation, database-role
changes, deployment, or service restart. A performs and records every command
in this section before public launch. Never paste secret values into chat,
issues, logs, screenshots, or shell command arguments.

### Runtime configuration inventory

The trusted-shell audit classifies and validates backend-visible settings with:

```bash
docker compose exec -T backend npm run security:config-audit
```

It prints only each setting name, its category, and `PASS` or `FAIL`. It never
prints values, hashes, credentials, URLs, tokens, keys, or passwords. The
production process must report `PASS` for every line. In particular, it rejects
all committed development/test secret placeholders, malformed encryption-key
shape, short service/signing secrets, enabled pilot tooling, debug/verbose
production logging, and secret reuse across unrelated backend trust boundaries.
`TELEGRAM_BOT_TOKEN` is intentionally bot-only: it is not injected into the
backend and is validated by the bot at startup against committed placeholders.

Secret settings:

- `DATABASE_URL`, `REDIS_URL`, `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `APP_ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN`, `BOT_INTERNAL_API_KEY`, and
  `TELEGRAM_CALLBACK_SIGNING_KEY`.

Security-sensitive non-secret settings:

- `NODE_ENV`, `PORT`, `LOG_LEVEL`, `JWT_ACCESS_TTL`, `BOT_INTERNAL_URL`,
  `BOT_INTERNAL_PORT`, `BACKEND_INTERNAL_URL`,
  `TELEGRAM_LINK_TOKEN_TTL_SECONDS`, `TELEGRAM_CALLBACK_REF_TTL_SECONDS`,
  `WOOCOMMERCE_REST_MAX_ATTEMPTS`,
  `PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS`,
  `PLUGIN_REGISTRATION_RATE_LIMIT`,
  `PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS`, `AUTH_REGISTER_RATE_LIMIT`,
  `AUTH_REGISTER_RATE_WINDOW_SECONDS`, `AUTH_LOGIN_RATE_LIMIT`,
  `AUTH_LOGIN_RATE_WINDOW_SECONDS`, `PILOT_MODE`, `PILOT_WEBHOOK_BASE_URL`,
  `POSTGRES_USER`, and `CADDY_DOMAIN`.

Ordinary configuration:

- `BOT_DELIVERY_TIMEOUT_MS`, `BOT_BACKEND_TIMEOUT_MS`,
  `BOT_STATUS_WRITE_TIMEOUT_MS`,
  `TELEGRAM_ORDER_FRESHNESS_THRESHOLD_SECONDS`,
  `WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS`,
  `WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS`,
  `WOOCOMMERCE_REST_BACKOFF_BASE_MS`, `WOOCOMMERCE_REST_BACKOFF_FACTOR`,
  `WOOCOMMERCE_REST_JITTER_RATIO`, `PILOT_READINESS_TIMEOUT_SECONDS`, and
  `POSTGRES_DB`.

`WOOCOMMERCE_WEBHOOK_SECRET` was removed from runtime configuration because it
had no consumer. Actual M8 HMAC secrets are unique per Store, generated by the
backend, encrypted at rest, returned only during their established one-time
ceremony, and never sourced from a global environment value.

Connector-owned material is not an environment setting: WooCommerce REST
consumer key/secret, plugin credential, per-Store webhook HMAC secret, and
endpoint routing key remain governed by M4/M7/M8. The endpoint key is routing
information, not authentication. Caddy uses its local state for normal ACME
automation; no DNS-provider/API credential is referenced by the current
repository. CI references no GitHub secret today; its `DATABASE_URL` is a
non-production test fixture.

### Secret action classification

`APP_ENCRYPTION_KEY` must not be rotated under P7.1. The config audit checks
only its exact 32-byte base64 shape. If repository or production evidence shows
that the deployed key is compromised, copied from an example, reused, or
otherwise unsafe, stop launch work: data-preserving key rotation requires a
separate approved design.

For all other boundaries, take action only from concrete evidence:

| Boundary                                       | Required action when unsafe/exposed                                        | Coordination                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| JWT signing                                    | Rotate                                                                     | Backend restart; existing access tokens become invalid                  |
| Telegram bot token                             | Revoke/reissue through Telegram                                            | Bot restart; no WCTM relink is expected                                 |
| Backend-bot service key                        | Rotate                                                                     | Coordinated backend and bot restart                                     |
| Callback signing                               | Rotate                                                                     | Backend restart; outstanding signed references expire immediately       |
| WooCommerce REST credential                    | Rotate in WooCommerce and update through the existing validated Store path | Backend uses the newly encrypted credential; no new trust path          |
| Plugin credential                              | Issue a new M7 token and reconnect                                         | Existing webhook material remains hidden and is reconciled by Retry     |
| Per-Store webhook HMAC secret                  | Use the existing M8 rotation then connector reconnect/reconciliation       | Coordinate to avoid an authentication gap; do not reuse plugin material |
| PostgreSQL login                               | Rotate or replace with the runtime role below                              | Update `DATABASE_URL`, then controlled backend restart                  |
| Redis password, when configured                | Rotate                                                                     | Update `REDIS_URL`, then controlled backend restart                     |
| Caddy ACME/DNS credential, if later configured | Rotate at the provider                                                     | Reload Caddy only after the replacement is present                      |
| GitHub Actions secret, if later added          | Rotate in repository settings                                              | Re-run only the affected workflow                                       |

No current-repository evidence requires rotation of a production credential.
That statement does not replace A's name-only production secret inventory.

The current `node:20-alpine` production base reached upstream end of life on
2026-04-30, and the Node/PostgreSQL/Redis base tags are not digest-pinned. Public
launch is blocked until A approves a supported Node major, compatible builds and
regressions pass, and the reviewed release candidate pins reproducible base
versions/digests. Do not work around this by pinning an unsupported Node 20 image
or silently changing the runtime major in P7.1.

### Host Caddy and HTTPS

Keep both the browser origin and the direct connector origin. The latter is
required for restricted/Iran-hosted WooCommerce stores and must remain DNS-only
when that routing constraint applies. The host-level shape is:

```caddyfile
wctm.walterbyte.com, connector.wctm.walterbyte.com {
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:3000
}
```

Caddy automatic HTTPS must remain enabled, which redirects HTTP to HTTPS. Do
not add `includeSubDomains` or `preload` to HSTS. The application serves
`/onboarding` with same-origin executable JavaScript and a CSP containing
`default-src 'none'`, `script-src 'self'`, `connect-src 'self'`,
`base-uri 'none'`, `frame-ancestors 'none'`, `object-src 'none'`, and
`form-action 'self'`, without `unsafe-eval`. It also sends `nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a restrictive
Permissions Policy, and `Cache-Control: no-store`. No wildcard CORS, cookies,
or browser token persistence are introduced.

### Network, TLS, SSH, and service verification

Run these read-only checks on the VPS after A has applied the host configuration
and deployed the reviewed release:

```bash
sudo ss -lntup
sudo ufw status verbose
sudo nft list ruleset
sudo sshd -T | rg '^(pubkeyauthentication|passwordauthentication|permitrootlogin) '
docker compose ps
docker compose port backend 3000
docker compose port postgres 5432 || true
docker compose port redis 6379 || true
docker compose port telegram-bot 3001 || true
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/readiness
curl --silent --show-error --output /dev/null --dump-header - http://wctm.walterbyte.com/onboarding
curl --silent --show-error --output /dev/null --dump-header - https://wctm.walterbyte.com/onboarding
curl --fail --silent --show-error https://connector.wctm.walterbyte.com/api/health
```

Expected results:

- only Caddy HTTP/HTTPS and the approved SSH administration port are public;
- backend reports only `127.0.0.1:${PORT}` on the host;
- PostgreSQL, Redis, and the bot return no host-published port;
- HTTP returns a redirect to the equivalent HTTPS URL;
- HTTPS includes the exact one-year HSTS value and the onboarding headers above;
- both health endpoints pass, including PostgreSQL and Redis readiness;
- the direct connector hostname remains reachable over trusted HTTPS.

The effective SSH baseline is public-key authentication enabled, password
authentication disabled unless A records a time-bounded recovery exception,
and direct root login disabled or deliberately constrained to key-only
administration. SSH configuration must contain no application secret.

### PostgreSQL runtime role

Inspect the backend's current database role without printing the connection
URL or password:

```bash
docker compose exec -T backend node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});(async()=>{await c.connect();const r=await c.query("select rolsuper, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname=current_user");const v=r.rows[0];console.log(JSON.stringify({superuser:v.rolsuper,createDb:v.rolcreatedb,createRole:v.rolcreaterole,replication:v.rolreplication}));await c.end()})().catch(()=>{console.error("database privilege audit failed");process.exitCode=1})'
```

All four values must be `false`. If any value is true, public launch is blocked
until A changes the application runtime identity. P7.2 will define the final
migration-role execution path; do not give the runtime role DDL or migration
ownership.

If correction is required, A may create a dedicated role through a hidden
password prompt, grant only connection/schema usage and M1-M22 table DML, then
update `DATABASE_URL` and restart the backend in a controlled window:

```bash
docker compose exec postgres sh -c 'createuser -U "$POSTGRES_USER" --login --no-superuser --no-createdb --no-createrole --no-replication wctm_runtime'
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\\password wctm_runtime"'
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
GRANT CONNECT ON DATABASE wc_telegram TO wctm_runtime;
GRANT USAGE ON SCHEMA public TO wctm_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  tenants, users, memberships, stores, webhook_events, orders, audit_logs,
  telegram_accounts, store_notification_recipients,
  telegram_settings_references, telegram_chat_authorizations,
  telegram_link_tokens, telegram_callback_references,
  telegram_order_note_actions, telegram_order_status_writes,
  telegram_order_notification_deliveries, inventory_items,
  telegram_inventory_references, telegram_search_references,
  telegram_inventory_notification_deliveries
TO wctm_runtime;
SQL
```

If the production database name is not `wc_telegram`, A must replace only that
identifier after confirming it by name; do not print or reconstruct the URL.
The procedure intentionally grants no superuser, database/schema creation,
role creation, replication, object ownership, DDL, or `_prisma_migrations`
write. PostgreSQL remains unpublished. Same-host private Docker traffic does
not require a new database TLS topology in P7.1.

### Redis, logs, and CI secret inventory

Redis has no published host port in Compose and is reachable only on the
project network. Under that topology, absence of a Redis password alone is not
a P7.1 launch blocker; authentication remains defense in depth. If A finds any
external/public Redis reachability, launch is blocked until authentication and
network isolation are both enforced.

Recent-log structure may be checked without printing matching lines:

```bash
if docker compose logs --since 30m backend telegram-bot | rg --quiet 'Bearer [A-Za-z0-9._-]+|postgres(?:ql)?://[^ ]+:[^ ]+@|redis(?:s)?://:[^ ]+@|X-Bot-Api-Key|X-WCTM-Plugin-Credential|X-WC-Webhook-Signature'; then echo 'FAIL: sensitive log structure detected'; else echo 'PASS: no sensitive log structure detected'; fi
```

If this reports FAIL, preserve access to the logs, do not paste the matching
line, and stop launch for a bounded secret-specific review. The central logger
redacts sensitive keys, configured runtime secret sentinels, authorization
text, request query strings, raw bodies/payloads, note bodies, search queries,
customer contact fields, Telegram updates, and signatures.

Inventory CI configuration by name only:

```bash
gh secret list --repo OWNER/REPOSITORY
gh variable list --repo OWNER/REPOSITORY
```

Do not use `gh secret set`, print environment dumps, `docker inspect` container
environments, `docker compose config`, or shell tracing during this validation;
those paths can expose values.
