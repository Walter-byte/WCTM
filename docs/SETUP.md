# Local Development Setup

The complete WC-Telegram-SaaS scaffold can run locally in under five minutes.

## Prerequisites

- Docker Desktop, Docker Engine, or an equivalent container runtime
- Docker Compose v2 (`docker compose version`)
- Git
- Optional for host-based TypeScript development: Node.js 24.20.0 and npm 11+

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

P7.1 repository work did not itself authorize SSH access, firewall/sshd/Caddy
changes, credential rotation, database-role changes, deployment, or service
restart. A owns and records every production action in this section. Never
paste secret values into chat, issues, logs, screenshots, command arguments, or
temporary files, and disable shell tracing before handling runtime secrets.

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
  `APP_ENCRYPTION_KEY`, temporary `APP_ENCRYPTION_PREVIOUS_KEY`,
  `TELEGRAM_BOT_TOKEN`, `BOT_INTERNAL_API_KEY`, and
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

### Application encryption-key inventory and rotation

`APP_ENCRYPTION_KEY` encrypts exactly these Prisma fields:

| Prisma field                                  | Database column                                    | Contents                                     |
| --------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `Store.consumerKeyEncrypted`                  | `stores.consumer_key_encrypted`                    | WooCommerce REST consumer key                |
| `Store.consumerSecretEncrypted`               | `stores.consumer_secret_encrypted`                 | WooCommerce REST consumer secret             |
| `Store.webhookSecretEncrypted`                | `stores.webhook_secret_encrypted`                  | Per-Store WooCommerce webhook HMAC secret    |
| `TelegramCallbackReference.noteBodyEncrypted` | `telegram_callback_references.note_body_encrypted` | Short-lived pending WooCommerce note body    |
| `TelegramSearchReference.queryEncrypted`      | `telegram_search_references.query_encrypted`       | Short-lived normalized Telegram search query |

The application uses AES-256-GCM with a random 12-byte IV and 16-byte
authentication tag. Stored ciphertext is three standard-base64 components in
`iv:auth-tag:ciphertext` order. The envelope embeds the IV and tag but no format
version, key version, key identifier, or key material. Existing records
therefore cannot be identified by key version from their text alone; the
operator command classifies them only by authenticated decryption with the
current key and, when configured, the previous key.

Store credential writes occur in `StoreService.create` and credential updates,
M7 registration finalization, and M8 webhook-credential provision/rotation.
Reads occur in Store connection tests, M7 connector-health/finalization, M8
webhook authentication, M9 reconciliation, M12/M17 WooCommerce order actions,
M19 bootstrap/projection, and private-pilot validation. M17 note preparation
writes the encrypted note body and confirmation decrypts it; cancellation,
completion, expiry cleanup, and stale-action recovery clear it. M20 search page
reference creation writes the encrypted normalized query and page navigation
decrypts it. No file, queue payload, connector option, bot state, Redis value,
or other non-database artifact is encrypted with this key. Plugin credentials
and registration/link tokens are hashes, callback references use the separate
callback signing key, and the endpoint routing key is not encrypted secret
material.

The rotation bridge is deliberately narrow:

- `APP_ENCRYPTION_KEY` is always the current write key;
- optional `APP_ENCRYPTION_PREVIOUS_KEY` is decrypt-only and temporary;
- all normal application writes immediately use the current key;
- all reads try the current key first and then the previous key;
- `security:rotate-encryption-key` is a trusted-shell Nest application-context
  command with no HTTP, Telegram, queue, or product surface;
- it preflights every non-null affected value, processes fixed 100-row read
  pages, and commits one affected row plus one secret-safe system AuditLog in a
  transaction;
- each row is decrypted with its authenticated source key, re-encrypted with
  the current key, decrypted again with the current key, and compared in memory
  before its conditional update;
- Store's two required and optional webhook fields update atomically together;
- concurrent row changes fail safely instead of being overwritten; rerunning
  resumes from the authenticated current/previous classification;
- output is deterministic model/total counts and status only. It never emits
  keys, plaintext, ciphertext, row identifiers, URLs, or exception detail.

Run the modes only from the trusted backend container:

```bash
docker compose exec -T backend npm run security:rotate-encryption-key -- inspect
docker compose exec -T backend npm run security:rotate-encryption-key -- rotate
docker compose exec -T backend npm run security:rotate-encryption-key -- verify
```

`inspect` succeeds when every value is readable and reports whether migration
is required. `rotate` requires the distinct previous key, refuses to write when
preflight finds any unreadable value, and verifies the complete dataset after
the row transactions. `verify` exits non-zero unless every value decrypts with
the current key and none requires the previous key. A repeated successful
`rotate` reports zero updated rows and values. The final production config
audit intentionally reports `FAIL` while the previous-key setting is present;
it is a migration-only state, not an acceptable steady state.

Generate independent replacements into shell memory without terminal output;
write them through the existing protected runtime-configuration procedure and
unset the variables immediately afterward:

```bash
set +x
umask 077
APP_ENCRYPTION_KEY_NEW="$(openssl rand -base64 32 | tr -d '\n')"
JWT_SECRET_NEW="$(openssl rand -hex 32)"
BOT_INTERNAL_API_KEY_NEW="$(openssl rand -hex 32)"
TELEGRAM_CALLBACK_SIGNING_KEY_NEW="$(openssl rand -hex 32)"
DATABASE_PASSWORD_NEW="$(openssl rand -hex 32)"
test "$(printf %s "$APP_ENCRYPTION_KEY_NEW" | openssl base64 -d -A | wc -c | tr -d ' ')" -eq 32
test "$JWT_SECRET_NEW" != "$BOT_INTERNAL_API_KEY_NEW"
test "$JWT_SECRET_NEW" != "$TELEGRAM_CALLBACK_SIGNING_KEY_NEW"
test "$BOT_INTERNAL_API_KEY_NEW" != "$TELEGRAM_CALLBACK_SIGNING_KEY_NEW"
```

The APP encryption key remains standard Base64 because application validation
requires a Base64 value that decodes to exactly 32 bytes. JWT, backend-bot,
callback-signing, and database-login replacements are each independently
generated from 32 random bytes and encoded as 64 lowercase hexadecimal
characters. In particular, the database password is directly safe in the
password component of the PostgreSQL URI and requires no manual percent-
encoding. Do not use ordinary Base64 for it.

### A-owned staged production transition

#### Stage 1 — preconditions

Before any encryption-key rotation, A must require all of the following:

1. The reviewed code is deployed without any live secret change.
2. Current health/readiness and the current Store connection test pass.
3. A fresh protected database backup exists and a one-off isolated restore of
   that exact backup succeeds.
4. A protected snapshot of the current runtime configuration and current
   application key exists outside the repository.
5. Console access and a maintenance window are available.

The one-off isolated restore is only a P7.1 operation-specific safety
prerequisite. It does not define backup scheduling, retention, RPO/RTO,
automation, off-site policy, generalized disaster recovery, or any other P7.3
work. If any prerequisite is absent, stop. Do not use shell tracing,
environment dumps, `docker inspect`, `docker compose config`, or command-line
secret arguments.

#### Stage 2 — rotate `APP_ENCRYPTION_KEY` only

Keep `NODE_ENV=development`, `LOG_LEVEL=log`, `PILOT_MODE=false`, the existing
production database identity, existing `JWT_SECRET`, existing
`BOT_INTERNAL_API_KEY`, and existing `TELEGRAM_CALLBACK_SIGNING_KEY` throughout
this stage.

1. Set `APP_ENCRYPTION_KEY` to the new value and
   `APP_ENCRYPTION_PREVIOUS_KEY` to the old value through the protected runtime
   configuration, then recreate/restart only the backend. Do not put either
   value on the command line.
2. Confirm health/readiness. Run `inspect`; require zero unreadable values and
   a count consistent with the five fields above. Run `rotate`, then `verify`;
   require `complete`, zero previous, and zero unreadable.
3. Require the Store connection test, connector health, an authenticated M8
   webhook, Telegram `/status`, representative order access, and `/stock` to
   pass. These operations must preserve the actual webhook secret and all
   hashed/routing credentials; only their database encryption wrapper changes.
4. Only after every check is clean, remove `APP_ENCRYPTION_PREVIOUS_KEY`,
   recreate/restart only the backend, run
   `verify` again with current key only, and repeat health/readiness plus the
   Store connection test. The new APP key is authoritative after this passes.

If a command or application check fails before step 4, keep the backend on both
keys and rerun safely after correcting the cause. Every committed row remains
readable with that dual-key configuration; do not casually restore the
database. Reverse rotation is permitted only while application traffic is
controlled: set the old key as current and the new key as previous, run the
same inspect/rotate/verify cycle, remove the previous key, and restore the
matching prior configuration. After current-key-only verification, the new APP
key is authoritative. Never restore an old database backup without its matching
protected key snapshot. Retain the old APP key securely until P7.1 production
validation formally closes.

#### Stage 3 — establish the restricted database role independently

After Stage 2 passes completely, create `wctm_runtime` with the new hexadecimal
database password, apply the already-approved exact least-privilege ACL below,
and verify its role flags, ownership, schema/database privileges, migration-
table exclusion, and exact application-table grants before using it. Do not
change the backend `DATABASE_URL` while creating or verifying the role. Keep the
privileged owner available for the current Prisma migration mechanism until
P7.2. Record a new protected rollback configuration snapshot containing the
new authoritative APP key. If role creation or verification fails, no
application rollback is necessary; correct the isolated role configuration
without widening grants ad hoc.

#### Stage 4 — switch only `DATABASE_URL`

Change only the backend runtime `DATABASE_URL` to authenticate as
`wctm_runtime`. Keep `NODE_ENV=development`, the existing JWT, existing backend-
bot key, existing callback-signing key, and the current APP encryption key only.
Restart only the backend, then prove under the real production restricted role:

- health/readiness;
- the actual current database role and all elevated flags false;
- login and Tenant read;
- representative application read and write;
- AuditLog insert; and
- authenticated webhook ingestion and projection.

If this stage fails, restore only the previous owner-backed backend
`DATABASE_URL` and restart the backend. Do not change schema/data or add ad-hoc
privileges; leave `wctm_runtime` available for diagnosis. Proceed only after
this isolated stage passes.

#### Stage 5 — service secrets and production mode

After the restricted database runtime is independently proven, save another
protected rollback baseline containing the current APP key, verified
`wctm_runtime` database connection, old JWT, old backend-bot key, and old
callback-signing key.

Stop backend and bot together. Install the new `JWT_SECRET`, the same new
`BOT_INTERNAL_API_KEY` on both sides, and the new
`TELEGRAM_CALLBACK_SIGNING_KEY`. Keep the current APP key only and the
restricted runtime `DATABASE_URL`; ensure `APP_ENCRYPTION_PREVIOUS_KEY` is
absent. Set `NODE_ENV=production`, `LOG_LEVEL=log`, and `PILOT_MODE=false`, then
start backend and bot together.

Require clean startup, every `security:config-audit` line to report `PASS`,
current-key-only encryption verification, restricted-role verification, a new
login, a bounded M1-M22 smoke, and a secret-safe recent-log scan. Replacing
`JWT_SECRET` intentionally invalidates all existing JWTs. Replacing the
callback-signing key invalidates outstanding signed callback references but not
durable business state. The coherent backend/bot stop and start prevents a
prolonged service-key mismatch. Do not weaken validation if production startup
fails.

After the protected configuration is safely stored, unset the local generation
variables:

```bash
unset APP_ENCRYPTION_KEY_NEW JWT_SECRET_NEW BOT_INTERNAL_API_KEY_NEW
unset TELEGRAM_CALLBACK_SIGNING_KEY_NEW DATABASE_PASSWORD_NEW
```

Service-secret rollback must respect each boundary: JWT rollback affects
sessions only; the backend-bot key must roll back on backend and bot together;
and callback-key rollback affects outstanding references, not durable business
state. If production-mode startup fails and service restoration is necessary,
do not weaken the validator: restore the immediately preceding protected
configuration baseline. P7.1 remained open until production validation was
formally accepted.

This cutover does not rotate `TELEGRAM_BOT_TOKEN`, per-Store webhook plaintext,
WooCommerce REST credentials, plugin credentials, registration/link-token
hashes, or endpoint routing keys. Rotate any of those only through their
existing separate authority when concrete evidence requires it.

Final production configuration must have this value-free state:

| Category               | Required state                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime mode           | `NODE_ENV=production`, `LOG_LEVEL=log`, `PILOT_MODE=false`                                                                                    |
| Database               | `DATABASE_URL` authenticates only as restricted `wctm_runtime` with its new unique password; owner credentials remain outside backend runtime |
| Application encryption | `APP_ENCRYPTION_KEY` is the verified new key; `APP_ENCRYPTION_PREVIOUS_KEY` is absent                                                         |
| JWT                    | `JWT_SECRET` is a new unique strong secret; pre-cutover JWTs are invalid                                                                      |
| Backend/bot trust      | one new strong `BOT_INTERNAL_API_KEY` is installed coherently in backend and bot only                                                         |
| Callback signing       | `TELEGRAM_CALLBACK_SIGNING_KEY` is a new unique strong secret; old outstanding callbacks are invalid                                          |
| Other secrets          | no committed development/test placeholder and no unrelated cross-boundary reuse                                                               |
| Audit                  | every line from `security:config-audit` reports `PASS`                                                                                        |

Do not add a wildcard, temporary validator bypass, exception value, or reduced
production rule to reach this state.

### Secret action classification

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

Production evidence confirms that the deployed application encryption key and
the listed development-placeholder service secrets require the coordinated
procedure above. That evidence does not authorize C to perform any production
action or broaden rotation to an unrelated credential.

The reviewed production images are exact patch/distro tags pinned to immutable
official-registry manifest digests. Do not replace them with `latest`, a
major/minor-only tag, or a tag without its digest:

| Service     | Selected official image                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Backend/bot | `node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`   |
| PostgreSQL  | `postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |
| Redis       | `redis:7.4.11-alpine3.21@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf`   |

Node 24.20.0 replaces the EOL Node 20 runtime for both application images.
PostgreSQL remains on major 16 and Redis remains on major 7.

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

All four values must be `false`. A's initial approved read-only audit returned
`true` for all four values, which established the original P7.1 launch blocker.
The following procedure was reviewed for A to execute in a controlled
production window; it was validated against an isolated PostgreSQL
16 instance containing the complete 16-migration M1-M22 schema. P7.2 will
define the supported privileged migration identity/path. The runtime role must
not own the schema, any relation, or `_prisma_migrations` and receives no DDL or
migration privilege.

Create the new role through a hidden password prompt. If `createuser` reports
that `wctm_runtime` already exists, stop and review that role rather than
silently reusing it:

```bash
docker compose exec -T postgres sh -c 'createuser -U "$POSTGRES_USER" --login --no-superuser --no-createdb --no-createrole --no-inherit --no-replication --no-bypassrls wctm_runtime'
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\\password wctm_runtime"'
```

Apply the reviewed grants as the current privileged database owner. The
database is dedicated to WCTM, so revoking public schema creation and temporary
table creation does not affect another application:

```bash
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -v database_name="$POSTGRES_DB" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;
ALTER ROLE wctm_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM wctm_runtime;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM wctm_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM wctm_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM wctm_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO wctm_runtime;
GRANT USAGE ON SCHEMA public TO wctm_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE
  tenants, users, memberships, stores, webhook_events, orders,
  telegram_accounts,
  telegram_settings_references, telegram_chat_authorizations,
  telegram_link_tokens, telegram_callback_references,
  telegram_order_note_actions, telegram_order_status_writes,
  telegram_order_notification_deliveries, inventory_items,
  telegram_inventory_notification_deliveries
TO wctm_runtime;
GRANT SELECT, INSERT ON TABLE
  audit_logs, telegram_inventory_references, telegram_search_references
TO wctm_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE store_notification_recipients
TO wctm_runtime;
COMMIT;
SQL
```

The DML matrix is derived from actual M1-M22 Prisma operations: application
state tables receive `SELECT`/`INSERT`/`UPDATE`; append-only audit and read-only
reference tables receive `SELECT`/`INSERT`; only selected-recipient mappings
receive `DELETE`. The procedure intentionally grants no sequence privilege,
superuser, database/schema creation, temporary-table creation, role creation,
replication, bypass-RLS, object ownership, DDL, or `_prisma_migrations` access.

Before switching the application, A must verify the role and grants from the
owner connection, still without printing a URL or password:

```bash
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT json_build_object(
  'superuser', rolsuper,
  'createDb', rolcreatedb,
  'createRole', rolcreaterole,
  'replication', rolreplication,
  'bypassRls', rolbypassrls
)
FROM pg_roles
WHERE rolname = 'wctm_runtime';
SELECT
  has_schema_privilege('wctm_runtime', 'public', 'USAGE') AS schema_usage,
  has_schema_privilege('wctm_runtime', 'public', 'CREATE') AS schema_create,
  has_database_privilege('wctm_runtime', current_database(), 'TEMP') AS database_temp,
  has_table_privilege('wctm_runtime', 'public._prisma_migrations', 'SELECT') OR
  has_table_privilege('wctm_runtime', 'public._prisma_migrations', 'INSERT') OR
  has_table_privilege('wctm_runtime', 'public._prisma_migrations', 'UPDATE') OR
  has_table_privilege('wctm_runtime', 'public._prisma_migrations', 'DELETE')
    AS migration_table_dml;
SELECT count(*) AS runtime_owned_objects
FROM pg_class
WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'wctm_runtime');
SQL
```

Expected: the four required role flags plus `bypassRls` are false,
`schema_usage` is true, `schema_create`, `database_temp`, and
`migration_table_dml` are false, and `runtime_owned_objects` is zero. Follow
Stage 4 above: update only the backend runtime `DATABASE_URL`, restart only the
backend, and prove health/readiness, the actual current role and flags,
login/Tenant read, representative application read/write, AuditLog insert, and
authenticated webhook/projection. Do not run Prisma Migrate as `wctm_runtime`.
PostgreSQL remains unpublished; same-host private Docker traffic does not
require a new database TLS topology in P7.1.

### P7.1 production closure record

After merge `5edce65`, A executed the staged D-030 transition successfully.
The operation-specific prerequisite created a fresh production backup, restored
that exact backup in isolated PostgreSQL 16.15, found 16 migrations and 21
public tables, and passed selected source/restored row-count comparison. This is
not generalized backup/restore/DR implementation; that remains P7.3.

APP-key inspection found 34 rows/38 encrypted values, all on the previous key
and none unreadable. Rotation updated all 34 rows/38 values. Verification with
the current key only, after removal of `APP_ENCRYPTION_PREVIOUS_KEY`, reported
38 current, zero previous, zero unreadable, and PASS. The new APP key is
authoritative; the protected pre-rotation snapshot remains retained for the
closure window.

Production now runs in production mode with `LOG_LEVEL=log`, `PILOT_MODE=false`,
restricted `wctm_runtime`, the current APP key only, independently rotated
unique JWT/backend-bot/callback/runtime-database secrets, and every security
configuration audit check passing. Runtime-role authentication, exact ACL and
restriction checks, application reads/writes, audited order-status mutation,
AuditLog insertion, webhook projection, health, and readiness passed without
permission errors. Owner/migration credentials remain outside backend runtime;
the supported privileged migration identity/path remains P7.2.

The final bounded M1–M22 production smoke passed login, Tenant read, Telegram
status/orders/search/report/stock, reversible settings, Store/connector health,
one authenticated synthetic WooCommerce order with exactly one correct Telegram
notification and callback, and final health/readiness. Recent permission and
secret-pattern/log-leak scans were clean. One isolated ordinary HTTP 404 had no
associated webhook, database, permission, secret, or runtime failure and was
non-blocking. P7.1 is complete; this record starts no P7.2+ work.

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
