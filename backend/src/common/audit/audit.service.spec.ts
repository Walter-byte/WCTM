import { describe, expect, it, jest } from '@jest/globals';

import type { PrismaService } from '../../prisma/prisma.service';
import type { TenantContextService } from '../../tenant/tenant-context.service';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('creates a tenant-scoped event while excluding sensitive metadata', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'aud_test' } as never);
    const prisma = { auditLog: { create } } as unknown as PrismaService;
    const tenantContext = {
      active: {
        tenantId: 'ten_a',
        userId: 'usr_actor',
        membershipRole: 'OWNER',
      },
    } as TenantContextService;
    const service = new AuditService(prisma, tenantContext);

    await service.record({
      action: 'store.updated',
      entity: 'Store',
      entityId: 'sto_a',
      metadata: {
        changedFields: ['name', 'consumerSecret', 'unexpected'],
        credentialsChanged: true,
        consumerSecret: 'raw-secret',
        token: 'raw-token',
        password: 'raw-password',
        status: 'ACTIVE',
      },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'ten_a',
        userId: 'usr_actor',
        action: 'store.updated',
        entityType: 'Store',
        entityId: 'sto_a',
        metadata: {
          changedFields: ['name'],
          credentialsChanged: true,
          status: 'ACTIVE',
        },
      }),
      select: { id: true },
    });
    expect(JSON.stringify(create.mock.calls)).not.toMatch(
      /raw-secret|raw-token|raw-password/
    );
  });
});
