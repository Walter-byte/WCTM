import { TenantEntitlementStatus } from '@prisma/client';

export interface ParsedEntitlementArguments {
  tenantId: string;
  status?: TenantEntitlementStatus;
  expiresAt?: Date | null;
}

export function parseEntitlementArguments(
  arguments_: string[]
): ParsedEntitlementArguments {
  let tenantId: string | undefined;
  let status: TenantEntitlementStatus | undefined;
  let expiresAt: Date | null | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];

    if (argument === '--tenant' && value) {
      if (tenantId !== undefined) {
        throw new Error('Tenant option must be provided exactly once');
      }
      tenantId = value;
      index += 1;
    } else if (argument === '--status' && value) {
      if (status !== undefined) {
        throw new Error('Status option must be provided at most once');
      }
      if (
        !Object.values(TenantEntitlementStatus).includes(
          value as TenantEntitlementStatus
        )
      ) {
        throw new Error('Status must be ACTIVE or SUSPENDED');
      }
      status = value as TenantEntitlementStatus;
      index += 1;
    } else if (argument === '--expires-at' && value) {
      if (expiresAt !== undefined) {
        throw new Error('Expiry options are contradictory');
      }
      const parsed = parseExactUtcTimestamp(value);
      if (!parsed) {
        throw new Error('Expiry must be an explicit ISO-8601 UTC timestamp');
      }
      expiresAt = parsed;
      index += 1;
    } else if (argument === '--clear-expiry') {
      if (expiresAt !== undefined) {
        throw new Error('Expiry options are contradictory');
      }
      expiresAt = null;
    } else {
      throw new Error('Unsupported entitlement option');
    }
  }

  if (!tenantId || tenantId.trim() === '') {
    throw new Error('An explicit --tenant identifier is required');
  }

  return { tenantId, status, expiresAt };
}

function parseExactUtcTimestamp(value: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
      value
    );
  if (!match) {
    return null;
  }

  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6]) ||
    parsed.getUTCMilliseconds() !== milliseconds
  ) {
    return null;
  }

  return parsed;
}
