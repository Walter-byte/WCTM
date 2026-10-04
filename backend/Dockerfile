FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS openssl-pinned

COPY scripts/ops/install-pinned-openssl.sh /tmp/install-pinned-openssl.sh

RUN sh /tmp/install-pinned-openssl.sh && rm /tmp/install-pinned-openssl.sh

FROM openssl-pinned AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
  && npm ci \
  && apk del .native-build-deps

FROM dependencies AS builder

COPY tsconfig.base.json ./
COPY backend ./backend

RUN npm run build --workspace=@wc-telegram/backend

FROM openssl-pinned AS migration

ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/migration/package.json backend/migration/package-lock.json ./

RUN npm ci --omit=dev --omit=optional --no-audit --no-fund \
  && rm -rf /root/.npm \
  && apk add --repositories-file /dev/null --no-network ca-certificates-bundle \
  && apk del --repositories-file /dev/null --no-network apk-tools \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./prisma.config.ts
COPY scripts/ops/run-migrations.sh /usr/local/bin/wctm-run-migrations

RUN chmod 0555 /usr/local/bin/wctm-run-migrations

USER node

ENTRYPOINT ["/usr/local/bin/wctm-run-migrations"]

FROM openssl-pinned AS production

ARG NPM_VERSION=11.19.1

ENV NODE_ENV=production
WORKDIR /app/backend

COPY package.json package-lock.json /app/
COPY backend/package.json /app/backend/package.json
COPY telegram-bot/package.json /app/telegram-bot/package.json

RUN npm install --global "npm@${NPM_VERSION}" --ignore-scripts --no-audit --no-fund \
  && apk add --no-cache --virtual .native-build-deps python3 make g++ \
  && npm ci --omit=dev --omit=optional --workspace=@wc-telegram/backend \
  && apk del .native-build-deps \
  && npm cache clean --force \
  && apk add --repositories-file /dev/null --no-network ca-certificates-bundle \
  && apk del --repositories-file /dev/null --no-network apk-tools \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder --chown=node:node /app/backend/dist ./dist
COPY --from=builder --chown=node:node /app/backend/prisma ./prisma
COPY --from=builder --chown=node:node /app/backend/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/node_modules/.prisma /app/node_modules/.prisma

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
