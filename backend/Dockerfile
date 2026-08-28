FROM node:20-alpine AS dependencies

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

FROM node:20-alpine AS production

ENV NODE_ENV=production
WORKDIR /app/backend

COPY package.json package-lock.json /app/
COPY backend/package.json /app/backend/package.json
COPY telegram-bot/package.json /app/telegram-bot/package.json

RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
  && npm ci --workspace=@wc-telegram/backend \
  && apk del .native-build-deps \
  && npm cache clean --force

COPY --from=builder --chown=node:node /app/backend/dist ./dist
COPY --from=builder --chown=node:node /app/backend/prisma ./prisma
COPY --from=builder --chown=node:node /app/backend/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/node_modules/.prisma /app/node_modules/.prisma

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
