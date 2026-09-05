import { describe, expect, it } from '@jest/globals';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PublicAuthController } from '../auth/public-auth.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { HealthController } from '../health/health.controller';
import { OnboardingController } from '../onboarding/onboarding.controller';
import { PluginRegistrationController } from '../store/plugin-registration.controller';
import { TelegramInternalController } from '../telegram/telegram-internal.controller';
import { BotApiKeyGuard } from '../telegram/guards/bot-api-key.guard';
import { WooCommerceWebhookController } from '../webhooks/woocommerce-webhook.controller';

type ControllerClass = { new (...args: never[]): unknown; name: string };

const CONTROLLERS: readonly ControllerClass[] = [
  PublicAuthController,
  HealthController,
  OnboardingController,
  PluginRegistrationController,
  TelegramInternalController,
  WooCommerceWebhookController,
];

function publicRoutes(): Array<{
  route: string;
  controller: ControllerClass;
  handler: object;
}> {
  return CONTROLLERS.flatMap((controller) => {
    const controllerPath = String(
      Reflect.getMetadata(PATH_METADATA, controller) ?? ''
    );
    const controllerIsPublic =
      Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;

    return Object.getOwnPropertyNames(controller.prototype).flatMap(
      (methodName) => {
        if (methodName === 'constructor') {
          return [];
        }

        const handler = (controller.prototype as Record<string, object>)[
          methodName
        ];
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as
          string | undefined;
        const isPublic =
          controllerIsPublic ||
          Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;

        if (method === undefined || methodPath === undefined || !isPublic) {
          return [];
        }

        const prefix = controllerPath === 'onboarding' ? '' : '/api';
        const path = [controllerPath, methodPath]
          .filter((part) => part !== '' && part !== '/')
          .join('/');
        return [
          {
            route: `${RequestMethod[method]} ${prefix}/${path}`,
            controller,
            handler,
          },
        ];
      }
    );
  });
}

describe('P7.1 production security baseline', () => {
  it('keeps the public HTTP route inventory explicit and bounded', () => {
    expect(
      publicRoutes()
        .map(({ route }) => route)
        .sort()
    ).toEqual(
      [
        'GET /api/health',
        'GET /api/health/readiness',
        'GET /onboarding',
        'GET /onboarding/app.js',
        'GET /onboarding/styles.css',
        'POST /api/auth/login',
        'POST /api/auth/register',
        'POST /api/internal/telegram/orders/detail',
        'POST /api/internal/telegram/orders/list',
        'POST /api/internal/telegram/orders/lookup',
        'POST /api/internal/telegram/orders/notes/cancel',
        'POST /api/internal/telegram/orders/notes/confirm',
        'POST /api/internal/telegram/orders/notes/options',
        'POST /api/internal/telegram/orders/notes/prepare',
        'POST /api/internal/telegram/orders/notes/start',
        'POST /api/internal/telegram/orders/refresh',
        'POST /api/internal/telegram/orders/status',
        'POST /api/internal/telegram/orders/transitions',
        'POST /api/internal/telegram/redeem',
        'POST /api/internal/telegram/report',
        'POST /api/internal/telegram/search',
        'POST /api/internal/telegram/search/select',
        'POST /api/internal/telegram/settings/action',
        'POST /api/internal/telegram/settings/input/apply',
        'POST /api/internal/telegram/settings/input/start',
        'POST /api/internal/telegram/settings/summary',
        'POST /api/internal/telegram/status',
        'POST /api/internal/telegram/stock/detail',
        'POST /api/internal/telegram/stock/list',
        'POST /api/internal/telegram/unlink',
        'POST /api/plugin/connection-health',
        'POST /api/plugin/register',
        'POST /api/webhooks/woocommerce/:endpointKey',
      ].sort()
    );
  });

  it('requires the dedicated bot key on every public internal Telegram route', () => {
    const internalRoutes = publicRoutes().filter(({ route }) =>
      route.includes('/api/internal/telegram/')
    );

    expect(internalRoutes.length).toBeGreaterThan(0);
    for (const { handler } of internalRoutes) {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
        []) as unknown[];
      expect(guards).toContain(BotApiKeyGuard);
    }
  });

  it('has no wildcard CORS and applies explicit bounded body parsers', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const bodyParsers = readFileSync(
      resolve(process.cwd(), 'src/http/body-parsers.ts'),
      'utf8'
    );
    const packageManifest = readFileSync(
      resolve(process.cwd(), 'package.json'),
      'utf8'
    );

    expect(main).not.toMatch(/enableCors|Access-Control-Allow-Origin/);
    expect(packageManifest).not.toMatch(/"cors"\s*:/);
    expect(main).toContain('configureBodyParsers(application)');
    expect(bodyParsers).toContain("JSON_BODY_LIMIT = '64kb'");
    expect(bodyParsers).toContain("WEBHOOK_BODY_LIMIT = '1mb'");
    expect(bodyParsers).toContain('inflate: false, limit: WEBHOOK_BODY_LIMIT');
    expect(bodyParsers).toContain('parameterLimit: 100');
  });

  it('keeps runtime containers non-root and private services unpublished', () => {
    const backendDockerfile = readFileSync(
      resolve(process.cwd(), 'Dockerfile'),
      'utf8'
    );
    const botDockerfile = readFileSync(
      resolve(process.cwd(), '../telegram-bot/Dockerfile'),
      'utf8'
    );
    const compose = readFileSync(
      resolve(process.cwd(), '../docker-compose.yml'),
      'utf8'
    );

    expect(backendDockerfile).toMatch(
      /FROM node:24\.20\.0-alpine3\.24@sha256:[a-f0-9]{64} AS production/
    );
    expect(botDockerfile).toMatch(
      /FROM node:24\.20\.0-alpine3\.24@sha256:[a-f0-9]{64} AS production/
    );
    expect(botDockerfile).toContain(
      'npm ci --omit=dev --omit=optional --workspace=@wc-telegram/telegram-bot'
    );
    for (const dockerfile of [backendDockerfile, botDockerfile]) {
      expect(dockerfile).toContain('ARG ALPINE_OPENSSL_VERSION=3.5.8-r0');
      expect(dockerfile).toContain('"libcrypto3=${ALPINE_OPENSSL_VERSION}"');
      expect(dockerfile).toContain('"libssl3=${ALPINE_OPENSSL_VERSION}"');
      expect(dockerfile).toContain('ARG NPM_VERSION=11.19.1');
      expect(dockerfile).toContain(
        'npm install --global "npm@${NPM_VERSION}" --ignore-scripts --no-audit --no-fund'
      );
    }
    expect(botDockerfile).toContain("rmSync('/app/node_modules/typescript'");
    expect(botDockerfile).not.toContain('.native-build-deps');
    expect(compose).toMatch(
      /image: postgres:16\.15-alpine3\.24@sha256:[a-f0-9]{64}/
    );
    expect(compose).toMatch(
      /image: redis:7\.4\.11-alpine3\.21@sha256:[a-f0-9]{64}/
    );
    expect(backendDockerfile).toContain(
      'npm ci --omit=dev --omit=optional --workspace=@wc-telegram/backend'
    );
    expect(backendDockerfile).toMatch(/\nUSER node\n/);
    expect(botDockerfile).toMatch(/\nUSER node\n/);
    expect(compose).toContain("- '127.0.0.1:${PORT}:${PORT}'");
    const backendStart = compose.indexOf('  backend:');
    const backendEnd = compose.indexOf('\n  telegram-bot:', backendStart);
    const backendBlock = compose.slice(backendStart, backendEnd);
    const botBlock = compose.slice(backendEnd);
    expect(backendBlock).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(botBlock).toContain('TELEGRAM_BOT_TOKEN');
    for (const service of ['postgres', 'redis', 'telegram-bot']) {
      const start = compose.indexOf(`  ${service}:`);
      const next = compose.indexOf('\n  ', start + 3);
      const block = compose.slice(start, next === -1 ? undefined : next);
      expect(block).not.toMatch(/\n\s+ports:/);
    }
  });

  it('sets the approved HSTS policy without subdomain or preload expansion', () => {
    const caddy = readFileSync(resolve(process.cwd(), '../Caddyfile'), 'utf8');

    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(caddy).not.toMatch(/includeSubDomains|preload/i);
  });
});
