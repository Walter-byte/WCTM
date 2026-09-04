import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { TenantEntitlementStatus, TenantPlan } from '@prisma/client';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { PrismaService } from '../prisma/prisma.service';
import { parseEntitlementArguments } from './entitlement-cli-arguments';
import {
  effectiveTenantEntitlementState,
  EntitlementService,
} from './entitlement.service';

const NOW = new Date('2026-09-04T08:00:00.000Z');

describe('M22 effective Tenant entitlement', () => {
  it.each<
    [TenantEntitlementStatus, Date | null, 'ACTIVE' | 'SUSPENDED' | 'EXPIRED']
  >([
    [TenantEntitlementStatus.ACTIVE, null, 'ACTIVE'],
    [
      TenantEntitlementStatus.ACTIVE,
      new Date('2026-09-04T08:00:01Z'),
      'ACTIVE',
    ],
    [
      TenantEntitlementStatus.ACTIVE,
      new Date('2026-09-04T08:00:00Z'),
      'EXPIRED',
    ],
    [
      TenantEntitlementStatus.ACTIVE,
      new Date('2026-09-04T07:59:59Z'),
      'EXPIRED',
    ],
    [TenantEntitlementStatus.SUSPENDED, null, 'SUSPENDED'],
    [
      TenantEntitlementStatus.SUSPENDED,
      new Date('2026-09-05T00:00:00Z'),
      'SUSPENDED',
    ],
    [
      TenantEntitlementStatus.SUSPENDED,
      new Date('2026-09-03T00:00:00Z'),
      'SUSPENDED',
    ],
  ])('evaluates %s with expiry %s as %s', (status, expiresAt, expected) => {
    expect(effectiveTenantEntitlementState({ status, expiresAt }, NOW)).toBe(
      expected
    );
  });

  it('parses inspect, mutation, expiry and clear-expiry commands deterministically', () => {
    expect(parseEntitlementArguments(['--tenant', 'ten_a'])).toEqual({
      tenantId: 'ten_a',
      status: undefined,
      expiresAt: undefined,
    });
    expect(
      parseEntitlementArguments([
        '--tenant',
        'ten_a',
        '--status',
        'ACTIVE',
        '--expires-at',
        '2026-09-05T00:00:00Z',
      ])
    ).toEqual({
      tenantId: 'ten_a',
      status: TenantEntitlementStatus.ACTIVE,
      expiresAt: new Date('2026-09-05T00:00:00Z'),
    });
    expect(
      parseEntitlementArguments(['--tenant', 'ten_a', '--clear-expiry'])
    ).toEqual({ tenantId: 'ten_a', status: undefined, expiresAt: null });
  });

  it('rejects malformed or contradictory arguments', () => {
    for (const arguments_ of [
      [],
      ['--tenant', 'ten_a', '--status', 'TRIAL'],
      ['--tenant', 'ten_a', '--expires-at', '2026-09-05'],
      ['--tenant', 'ten_a', '--expires-at', '2026-02-30T00:00:00Z'],
      ['--tenant', 'ten_a', '--tenant', 'ten_b'],
      ['--tenant', 'ten_a', '--status', 'ACTIVE', '--status', 'SUSPENDED'],
      [
        '--tenant',
        'ten_a',
        '--expires-at',
        '2026-09-05T00:00:00Z',
        '--clear-expiry',
      ],
      ['--tenant', 'ten_a', '--unknown'],
    ]) {
      expect(() => parseEntitlementArguments(arguments_)).toThrow();
    }
  });
});

describe('EntitlementService', () => {
  it('resolves only the explicitly selected non-deleted Tenant', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      plan: TenantPlan.PRO,
      entitlementStatus: TenantEntitlementStatus.ACTIVE,
      entitlementExpiresAt: null,
    } as never);
    const service = new EntitlementService(
      { tenant: { findFirst } } as unknown as PrismaService,
      { log: jest.fn() } as unknown as StructuredLoggerService
    );

    await expect(service.resolveTenant('ten_a', { now: NOW })).resolves.toEqual(
      {
        plan: TenantPlan.PRO,
        status: TenantEntitlementStatus.ACTIVE,
        effectiveState: 'ACTIVE',
        expiresAt: null,
      }
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'ten_a', deletedAt: null },
      select: {
        plan: true,
        entitlementStatus: true,
        entitlementExpiresAt: true,
      },
    });
  });

  it('rejects a missing or deleted Tenant without mutation', async () => {
    const service = new EntitlementService(
      {
        tenant: { findFirst: jest.fn().mockResolvedValue(null as never) },
      } as unknown as PrismaService,
      { log: jest.fn() } as unknown as StructuredLoggerService
    );

    await expect(
      service.resolveTenant('ten_missing', { now: NOW })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to manage a nonexistent or deleted Tenant without any write', async () => {
    const update = jest.fn();
    const auditCreate = jest.fn();
    const logger = { log: jest.fn() };
    const transaction = {
      tenant: {
        findFirst: jest.fn(async () => null),
        update,
      },
      auditLog: { create: auditCreate },
    };
    const service = new EntitlementService(
      {
        $transaction: jest.fn(
          async (operation: (client: typeof transaction) => Promise<unknown>) =>
            operation(transaction)
        ),
      } as unknown as PrismaService,
      logger as unknown as StructuredLoggerService
    );

    await expect(
      service.manage({
        tenantId: 'ten_missing',
        status: TenantEntitlementStatus.SUSPENDED,
        correlationId: 'entitlement-command-test',
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('manages only one explicit Tenant and preserves expiry semantics', async () => {
    const tenant: {
      id: string;
      plan: TenantPlan;
      entitlementStatus: TenantEntitlementStatus;
      entitlementExpiresAt: Date | null;
    } = {
      id: 'ten_a',
      plan: TenantPlan.AGENCY,
      entitlementStatus: TenantEntitlementStatus.ACTIVE,
      entitlementExpiresAt: null,
    };
    const auditCreate = jest.fn(async () => ({ id: 'aud_a' }));
    const transaction = {
      tenant: {
        findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === tenant.id ? { ...tenant } : null
        ),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (data['entitlementStatus'] !== undefined) {
            tenant.entitlementStatus = data[
              'entitlementStatus'
            ] as TenantEntitlementStatus;
          }
          if (data['entitlementExpiresAt'] !== undefined) {
            tenant.entitlementExpiresAt = data[
              'entitlementExpiresAt'
            ] as Date | null;
          }
          return { ...tenant };
        }),
      },
      auditLog: { create: auditCreate },
    };
    const logger = { log: jest.fn() };
    const service = new EntitlementService(
      {
        $transaction: jest.fn(
          async (operation: (client: typeof transaction) => Promise<unknown>) =>
            operation(transaction)
        ),
      } as unknown as PrismaService,
      logger as unknown as StructuredLoggerService
    );

    await expect(
      service.manage(
        {
          tenantId: 'ten_a',
          expiresAt: new Date('2026-09-03T00:00:00Z'),
          correlationId: 'entitlement-command-test',
        },
        NOW
      )
    ).resolves.toMatchObject({ effectiveState: 'EXPIRED' });
    await expect(
      service.manage(
        {
          tenantId: 'ten_a',
          status: TenantEntitlementStatus.ACTIVE,
          correlationId: 'entitlement-command-test',
        },
        NOW
      )
    ).resolves.toMatchObject({ effectiveState: 'EXPIRED' });
    await expect(
      service.manage(
        {
          tenantId: 'ten_a',
          expiresAt: null,
          correlationId: 'entitlement-command-test',
        },
        NOW
      )
    ).resolves.toMatchObject({ effectiveState: 'ACTIVE', expiresAt: null });
    await expect(
      service.manage(
        {
          tenantId: 'ten_a',
          status: TenantEntitlementStatus.SUSPENDED,
          correlationId: 'entitlement-command-test',
        },
        NOW
      )
    ).resolves.toMatchObject({ effectiveState: 'SUSPENDED' });

    expect(transaction.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: 'ten_a', deletedAt: null },
      select: expect.any(Object),
    });
    expect(auditCreate).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('ten_a');
    expect(JSON.stringify(logger.log.mock.calls)).not.toMatch(
      /email|telegram|credential/i
    );
  });
});
