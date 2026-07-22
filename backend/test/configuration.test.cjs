const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { inspect } = require('node:util');
const { test } = require('node:test');
const { resolve } = require('node:path');

const { ConfigService } = require('@nestjs/config');

const {
  ApplicationConfigService,
} = require('../dist/config/application-config.service');
const { CONFIG_ENV_KEYS } = require('../dist/config/configuration.types');
const {
  validateEnvironment,
} = require('../dist/config/environment.validation');

const validEnvironment = (overrides = {}) => ({
  NODE_ENV: 'development',
  PORT: '3100',
  LOG_LEVEL: 'log',
  DATABASE_URL: 'postgresql://app:database-password@localhost:5432/app',
  REDIS_URL: 'redis://:redis-password@localhost:6379',
  JWT_SECRET: 'valid-jwt-secret-value-at-least-32-characters',
  JWT_ACCESS_TTL: '15m',
  APP_ENCRYPTION_KEY: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
  TELEGRAM_BOT_TOKEN: '1234567890:valid-test-token-value-12345',
  WOOCOMMERCE_WEBHOOK_SECRET:
    'valid-webhook-secret-value-at-least-32-characters',
  ...overrides,
});

const createConfiguration = (environment) => {
  const validated = validateEnvironment(environment);
  return new ApplicationConfigService(new ConfigService(validated));
};

test('valid environment loads typed configuration values', () => {
  const configuration = createConfiguration(validEnvironment());

  assert.deepEqual(configuration.app, {
    nodeEnv: 'development',
    port: 3100,
    logLevel: 'log',
  });
  assert.equal(
    configuration.postgres.url,
    'postgresql://app:database-password@localhost:5432/app'
  );
  assert.equal(
    configuration.redis.url,
    'redis://:redis-password@localhost:6379'
  );
  assert.equal(
    configuration.jwt.secret,
    'valid-jwt-secret-value-at-least-32-characters'
  );
  assert.equal(configuration.jwt.accessTokenTtl, '15m');
  assert.equal(
    configuration.encryption.key,
    'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
  );
  assert.deepEqual(configuration.woocommerce.rest, {
    maxAttempts: 3,
    attemptTimeoutMs: 5000,
    totalTimeoutMs: 15000,
    backoffBaseMs: 300,
    backoffFactor: 2,
    jitterRatio: 0.2,
  });
});

test('test environment supplies isolated safe defaults', () => {
  const validated = validateEnvironment({
    NODE_ENV: 'test',
    JWT_ACCESS_TTL: '15m',
  });

  assert.equal(validated.NODE_ENV, 'test');
  assert.equal(validated.PORT, 3000);
  assert.equal(validated.LOG_LEVEL, 'error');
  assert.match(validated.DATABASE_URL, /wc_telegram_test/);
});

test('WooCommerce REST resilience limits accept typed configuration overrides', () => {
  const configuration = createConfiguration(
    validEnvironment({
      WOOCOMMERCE_REST_MAX_ATTEMPTS: '4',
      WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS: '4500',
      WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS: '14000',
      WOOCOMMERCE_REST_BACKOFF_BASE_MS: '250',
      WOOCOMMERCE_REST_BACKOFF_FACTOR: '3',
      WOOCOMMERCE_REST_JITTER_RATIO: '0.1',
    })
  );

  assert.deepEqual(configuration.woocommerce.rest, {
    maxAttempts: 4,
    attemptTimeoutMs: 4500,
    totalTimeoutMs: 14000,
    backoffBaseMs: 250,
    backoffFactor: 3,
    jitterRatio: 0.1,
  });
});

test('missing required variables produce one aggregated safe error', () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: 'development' }),
    (error) => {
      assert.match(error.message, /Configuration validation failed/);
      assert.match(error.message, /DATABASE_URL is required/);
      assert.match(error.message, /JWT_SECRET is required/);
      assert.match(error.message, /JWT_ACCESS_TTL is required/);
      assert.match(error.message, /APP_ENCRYPTION_KEY is required/);
      assert.match(error.message, /TELEGRAM_BOT_TOKEN is required/);
      assert.match(error.message, /WOOCOMMERCE_WEBHOOK_SECRET is required/);
      return true;
    }
  );
});

test('invalid production bootstrap exits non-zero with aggregated errors', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(__dirname, '../dist/main.js')],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { NODE_ENV: 'production' },
    }
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /Configuration validation failed/);
  assert.match(output, /DATABASE_URL is required/);
  assert.match(output, /REDIS_URL is required/);
  assert.match(output, /JWT_SECRET is required/);
  assert.match(output, /JWT_ACCESS_TTL is required/);
  assert.match(output, /APP_ENCRYPTION_KEY is required/);
  assert.match(output, /TELEGRAM_BOT_TOKEN is required/);
  assert.match(output, /WOOCOMMERCE_WEBHOOK_SECRET is required/);
});

test('invalid port and encryption key report clear rules together', () => {
  assert.throws(
    () =>
      validateEnvironment(
        validEnvironment({
          PORT: 'not-a-number',
          APP_ENCRYPTION_KEY: 'too-short',
        })
      ),
    (error) => {
      assert.match(error.message, /PORT must be numeric/);
      assert.match(
        error.message,
        /APP_ENCRYPTION_KEY must be valid base64 encoding exactly 32 bytes/
      );
      assert.doesNotMatch(error.message, /too-short/);
      return true;
    }
  );
});

test('production rejects documented development placeholder values', () => {
  const developmentOnlyJwtSecret = 'development-only-jwt-secret-change-me';

  assert.throws(
    () =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: '3000',
        LOG_LEVEL: 'log',
        DATABASE_URL:
          'postgresql://wc_telegram:development-only-postgres-password@postgres:5432/wc_telegram',
        REDIS_URL: 'redis://redis:6379',
        JWT_SECRET: developmentOnlyJwtSecret,
        JWT_ACCESS_TTL: '15m',
        APP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        TELEGRAM_BOT_TOKEN: '0000000000:development-placeholder-token',
        WOOCOMMERCE_WEBHOOK_SECRET: 'development-only-webhook-secret-change-me',
      }),
    (error) => {
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_SECRET/);
      assert.match(error.message, /APP_ENCRYPTION_KEY/);
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
      assert.match(error.message, /WOOCOMMERCE_WEBHOOK_SECRET/);
      assert.doesNotMatch(error.message, new RegExp(developmentOnlyJwtSecret));
      return true;
    }
  );
});

test('configuration serialization and inspection redact every secret', () => {
  const environment = validEnvironment();
  const configuration = createConfiguration(environment);
  const output = [
    JSON.stringify(configuration),
    String(configuration),
    inspect(configuration),
    JSON.stringify(configuration.jwt),
    inspect(configuration.postgres),
  ].join('\n');

  for (const secret of [
    environment.DATABASE_URL,
    environment.REDIS_URL,
    environment.JWT_SECRET,
    environment.APP_ENCRYPTION_KEY,
    environment.TELEGRAM_BOT_TOKEN,
    environment.WOOCOMMERCE_WEBHOOK_SECRET,
  ]) {
    assert.doesNotMatch(
      output,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  }

  assert.match(output, /\*\*\*\*/);
});

test('.env.example keys exactly match the validation contract', () => {
  const template = readFileSync(
    resolve(__dirname, '../../.env.example'),
    'utf8'
  );
  const templateKeys = template
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')))
    .sort();

  assert.deepEqual(templateKeys, [...CONFIG_ENV_KEYS].sort());
});
