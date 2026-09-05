FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN npm ci --workspace=@wc-telegram/telegram-bot --include-workspace-root

FROM dependencies AS builder

COPY tsconfig.base.json ./
COPY telegram-bot ./telegram-bot

RUN npm run build --workspace=@wc-telegram/telegram-bot

FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS production

ARG ALPINE_OPENSSL_VERSION=3.5.8-r0
ARG NPM_VERSION=11.19.1

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN apk add --no-cache \
    "libcrypto3=${ALPINE_OPENSSL_VERSION}" \
    "libssl3=${ALPINE_OPENSSL_VERSION}" \
  && npm install --global "npm@${NPM_VERSION}" --ignore-scripts --no-audit --no-fund \
  && npm ci --omit=dev --omit=optional --workspace=@wc-telegram/telegram-bot \
  && node -e "require('node:fs').rmSync('/app/node_modules/typescript', { recursive: true, force: true })" \
  && npm cache clean --force

COPY --from=builder --chown=node:node /app/telegram-bot/dist ./telegram-bot/dist

USER node

CMD ["node", "telegram-bot/dist/index.js"]
