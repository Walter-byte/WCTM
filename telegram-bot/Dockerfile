FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS openssl-pinned

COPY scripts/ops/install-pinned-openssl.sh /tmp/install-pinned-openssl.sh

RUN sh /tmp/install-pinned-openssl.sh && rm /tmp/install-pinned-openssl.sh

FROM openssl-pinned AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN npm ci --workspace=@wc-telegram/telegram-bot --include-workspace-root

FROM dependencies AS builder

COPY tsconfig.base.json ./
COPY telegram-bot ./telegram-bot

RUN npm run build --workspace=@wc-telegram/telegram-bot

FROM openssl-pinned AS production

ARG NPM_VERSION=11.19.1

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN npm install --global "npm@${NPM_VERSION}" --ignore-scripts --no-audit --no-fund \
  && npm ci --omit=dev --omit=optional --workspace=@wc-telegram/telegram-bot \
  && node -e "require('node:fs').rmSync('/app/node_modules/typescript', { recursive: true, force: true })" \
  && npm cache clean --force \
  && apk add --repositories-file /dev/null --no-network ca-certificates-bundle \
  && apk del --repositories-file /dev/null --no-network apk-tools \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder --chown=node:node /app/telegram-bot/dist ./telegram-bot/dist

USER node

CMD ["node", "telegram-bot/dist/index.js"]
