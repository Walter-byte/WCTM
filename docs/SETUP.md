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

The Telegram transport and backend share `BOT_INTERNAL_API_KEY` as a dedicated
service credential. Generate a strong random value outside local development;
never reuse the Telegram bot token or a user JWT. `BACKEND_INTERNAL_URL` is the
backend API base URL used only by the bot (the Compose default is
`http://backend:3000/api`). Telegram account-link tokens default to a
900-second lifetime through `TELEGRAM_LINK_TOKEN_TTL_SECONDS`.
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
   webhook secret and endpoint key, and registers the four required order
   webhooks at the public Caddy route;
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

Docker starts:

1. PostgreSQL 16 and Redis 7 with persistent named volumes.
2. The NestJS backend after both data services pass health checks.
3. The grammY bot transport, which calls the backend internal Telegram API.
4. Caddy as the HTTP/HTTPS entry point.

Expected application log messages include:

```text
NestJS application started on port 3000
{"event":"telegram_bot_polling_started",...}
```

## 3. Verify Services

In another terminal:

```bash
docker compose ps
curl http://localhost
curl http://localhost/api/health
docker compose exec postgres pg_isready \
  -U "$(awk -F= '/^POSTGRES_USER=/{print $2}' .env)" \
  -d "$(awk -F= '/^POSTGRES_DB=/{print $2}' .env)"
docker compose exec redis redis-cli ping
```

Expected HTTP responses:

```text
WC-Telegram-SaaS is running
{"status":"ok"}
```

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

The default `CADDY_DOMAIN=http://localhost` keeps local development on plain
HTTP. Set `CADDY_DOMAIN` to a publicly resolvable hostname without the
`http://` scheme in production so Caddy can automatically provision a trusted
TLS certificate.

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

WordPress core is intentionally excluded from this repository. The connector
scaffold is stored under `wp-content/plugins/`. To inspect it in a local
WordPress environment:

1. Copy the connector files from this repository's `wp-content/plugins/` into
   the WordPress installation's `wp-content/plugins/wc-telegram-connector/`
   directory.
2. Install and activate WooCommerce.
3. Activate **WC Telegram Connector** from the Plugins screen.

Without WooCommerce, the plugin still activates safely and displays an
administrator notice.

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
