import {
  CONFIG_ENV_KEYS,
  type ValidatedEnvironment,
} from '../config/configuration.types';
import { validateEnvironment } from '../config/environment.validation';

export type SecurityConfigCategory =
  'secret' | 'security-sensitive non-secret' | 'ordinary configuration';

const CONFIG_CATEGORIES = {
  NODE_ENV: 'security-sensitive non-secret',
  PORT: 'security-sensitive non-secret',
  LOG_LEVEL: 'security-sensitive non-secret',
  DATABASE_URL: 'secret',
  REDIS_URL: 'secret',
  JWT_SECRET: 'secret',
  JWT_ACCESS_TTL: 'security-sensitive non-secret',
  APP_ENCRYPTION_KEY: 'secret',
  BOT_INTERNAL_API_KEY: 'secret',
  BOT_INTERNAL_URL: 'security-sensitive non-secret',
  BOT_INTERNAL_PORT: 'security-sensitive non-secret',
  BOT_DELIVERY_TIMEOUT_MS: 'ordinary configuration',
  BACKEND_INTERNAL_URL: 'security-sensitive non-secret',
  BOT_BACKEND_TIMEOUT_MS: 'ordinary configuration',
  BOT_STATUS_WRITE_TIMEOUT_MS: 'ordinary configuration',
  TELEGRAM_LINK_TOKEN_TTL_SECONDS: 'security-sensitive non-secret',
  TELEGRAM_CALLBACK_SIGNING_KEY: 'secret',
  TELEGRAM_CALLBACK_REF_TTL_SECONDS: 'security-sensitive non-secret',
  TELEGRAM_ORDER_FRESHNESS_THRESHOLD_SECONDS: 'ordinary configuration',
  WOOCOMMERCE_REST_MAX_ATTEMPTS: 'security-sensitive non-secret',
  WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS: 'ordinary configuration',
  WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS: 'ordinary configuration',
  WOOCOMMERCE_REST_BACKOFF_BASE_MS: 'ordinary configuration',
  WOOCOMMERCE_REST_BACKOFF_FACTOR: 'ordinary configuration',
  WOOCOMMERCE_REST_JITTER_RATIO: 'ordinary configuration',
  PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS: 'security-sensitive non-secret',
  PLUGIN_REGISTRATION_RATE_LIMIT: 'security-sensitive non-secret',
  PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS: 'security-sensitive non-secret',
  AUTH_REGISTER_RATE_LIMIT: 'security-sensitive non-secret',
  AUTH_REGISTER_RATE_WINDOW_SECONDS: 'security-sensitive non-secret',
  AUTH_LOGIN_RATE_LIMIT: 'security-sensitive non-secret',
  AUTH_LOGIN_RATE_WINDOW_SECONDS: 'security-sensitive non-secret',
  PILOT_MODE: 'security-sensitive non-secret',
  PILOT_WEBHOOK_BASE_URL: 'security-sensitive non-secret',
  PILOT_READINESS_TIMEOUT_SECONDS: 'ordinary configuration',
  POSTGRES_DB: 'ordinary configuration',
  POSTGRES_USER: 'security-sensitive non-secret',
  POSTGRES_PASSWORD: 'secret',
  CADDY_DOMAIN: 'security-sensitive non-secret',
} as const satisfies Record<keyof ValidatedEnvironment, SecurityConfigCategory>;

export interface SecurityConfigAuditResult {
  passed: boolean;
  lines: readonly string[];
}

export function runSecurityConfigAudit(
  environment: Record<string, unknown>
): SecurityConfigAuditResult {
  let validationMessage = '';

  try {
    validateEnvironment(environment);
  } catch (error) {
    validationMessage = error instanceof Error ? error.message : '';
  }

  const lines = CONFIG_ENV_KEYS.map((name) => {
    const failed =
      validationMessage.includes(name) ||
      (name === 'NODE_ENV' && environment['NODE_ENV'] !== 'production');
    return `${failed ? 'FAIL' : 'PASS'} ${name} [${CONFIG_CATEGORIES[name]}]`;
  });
  const boundaryFailure = validationMessage.includes(
    'must not reuse one secret across trust boundaries'
  );
  lines.push(
    `${boundaryFailure ? 'FAIL' : 'PASS'} SECRET_BOUNDARY_SEPARATION [security-sensitive non-secret]`
  );

  return {
    passed: !lines.some((line) => line.startsWith('FAIL ')),
    lines,
  };
}
