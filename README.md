# WC-Telegram-SaaS

Production-oriented, multi-tenant SaaS foundation for managing WooCommerce
stores through Telegram.

## Architecture

```text
+-------------------+        +-------------------+
| Telegram Managers |------->| grammY Bot        |
+-------------------+        +---------+---------+
                                           |
                                           v
+-------------------+        +-------------+-----+
| WooCommerce Store |------->| Caddy             |
| Connector Plugin  | HTTPS  | Reverse Proxy     |
+-------------------+        +-------------+-----+
                                           |
                                           v
                             +-------------+-----+
                             | NestJS Backend    |
                             | Multi-tenant API  |
                             +------+-------+----+
                                    |       |
                                    v       v
                           +--------+--+  +--+-------------+
                           | PostgreSQL |  | Redis / BullMQ |
                           +-----------+  +----------------+
```

The monorepo contains:

- `backend/` — NestJS API and future BullMQ workers.
- `telegram-bot/` — grammY bot process.
- `wp-content/plugins/` — lightweight WooCommerce connector plugin scaffold.
- `docs/` — architecture and developer documentation.
- `scripts/` — local infrastructure initialization scripts.

n8n is optional internal tooling and is not part of the production runtime.

## Quick Start

Prerequisites: Docker with Docker Compose v2.

```bash
cp .env.example .env
docker compose up --build
```

Verify the stack:

- Placeholder page: `http://localhost`
- Backend health: `http://localhost/api/health`
- Container status: `docker compose ps`

Stop the stack with `docker compose down`. Add `--volumes` only when you
intentionally want to delete local PostgreSQL, Redis, and Caddy data.

## Development

Install workspace dependencies and run the quality checks:

```bash
npm install
npm run prisma:validate --workspace backend
npm run prisma:generate --workspace backend
npm run typecheck
npm run lint
npm run format:check
npm test
```

The Prisma schema and versioned migrations live under `backend/prisma/`.

Use
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for
repository history, for example `feat(init): scaffold monorepo`.

See [Local Setup](docs/SETUP.md) for detailed instructions. Project planning
and decisions are maintained in the remaining files under `docs/`.
