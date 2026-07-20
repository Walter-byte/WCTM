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

The Telegram bot scaffold does not call the Telegram API, so the placeholder
token is sufficient for local startup.

## 2. Start the Docker Stack

```bash
docker compose up --build
```

Docker starts:

1. PostgreSQL 16 and Redis 7 with persistent named volumes.
2. The NestJS backend after both data services pass health checks.
3. The offline grammY bot scaffold.
4. Caddy as the HTTP/HTTPS entry point.

Expected application log messages include:

```text
NestJS application started on port 3000
Bot started
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
```

Use `npm run format` to apply Prettier formatting.

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
Caddy state. Use it only when a clean environment is intended.
