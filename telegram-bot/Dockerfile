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
COPY telegram-bot ./telegram-bot

RUN npm run build --workspace=@wc-telegram/telegram-bot

FROM node:20-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY telegram-bot/package.json ./telegram-bot/package.json

RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
  && npm ci --omit=dev --workspace=@wc-telegram/telegram-bot \
  && apk del .native-build-deps \
  && npm cache clean --force

COPY --from=builder --chown=node:node /app/telegram-bot/dist ./telegram-bot/dist

USER node

CMD ["node", "telegram-bot/dist/index.js"]
