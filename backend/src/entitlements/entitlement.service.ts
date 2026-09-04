import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TenantEntitlementStatus, TenantPlan } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { PrismaService } from '../prisma/prisma.service';

export type EffectiveTenantEntitlementState =
  'ACTIVE' | 'SUSPENDED' | 'EXPIRED';

export interface TenantEntitlementRecord {
  plan: TenantPlan;
  status: TenantEntitlementStatus;
  expiresAt: Date | null;
}

export interface TenantEntitlementSummary {
  plan: TenantPlan;
  status: TenantEntitlementStatus;
  effectiveState: EffectiveTenantEntitlementState;
  expiresAt: string | null;
}

export interface ManageTenantEntitlementInput {
  tenantId: string;
  status?: TenantEntitlementStatus;
  expiresAt?: Date | null;
  correlationId: string;
}

type EntitlementDatabase = Pick<Prisma.TransactionClient, 'tenant'>;

export function effectiveTenantEntitlementState(
  record: Pick<TenantEntitlementRecord, 'status' | 'expiresAt'>,
  now: Date
): EffectiveTenantEntitlementState {
  if (record.status === TenantEntitlementStatus.SUSPENDED) {
    return 'SUSPENDED';
  }

  if (
    record.expiresAt !== null &&
    now.getTime() >= record.expiresAt.getTime()
  ) {
    return 'EXPIRED';
  }

  return 'ACTIVE';
}

export class EntitlementInactiveException extends ForbiddenException {
  constructor(
    readonly effectiveState: Exclude<EffectiveTenantEntitlementState, 'ACTIVE'>
  ) {
    super({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Tenant entitlement is inactive',
      code: 'ENTITLEMENT_INACTIVE',
      effectiveState,
    });
  }
}

@Injectable()
export class EntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService
  ) {}

  async resolveTenant(
    tenantId: string,
    options: { database?: EntitlementDatabase; now?: Date } = {}
  ): Promise<TenantEntitlementSummary> {
    const database = options.database ?? this.prisma;
    const tenant = await database.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        plan: true,
        entitlementStatus: true,
        entitlementExpiresAt: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant was not found');
    }

    return this.toSummary(
      {
        plan: tenant.plan,
        status: tenant.entitlementStatus,
        expiresAt: tenant.entitlementExpiresAt,
      },
      options.now ?? new Date()
    );
  }

  async assertActive(
    tenantId: string,
    options: { database?: EntitlementDatabase; now?: Date } = {}
  ): Promise<TenantEntitlementSummary> {
    const entitlement = await this.resolveTenant(tenantId, options);

    if (entitlement.effectiveState !== 'ACTIVE') {
      throw new EntitlementInactiveException(entitlement.effectiveState);
    }

    return entitlement;
  }

  async isActive(
    tenantId: string,
    options: { database?: EntitlementDatabase; now?: Date } = {}
  ): Promise<boolean> {
    return (
      (await this.resolveTenant(tenantId, options)).effectiveState === 'ACTIVE'
    );
  }

  async manage(
    input: ManageTenantEntitlementInput,
    now = new Date()
  ): Promise<TenantEntitlementSummary> {
    const result = await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.tenant.findFirst({
          where: { id: input.tenantId, deletedAt: null },
          select: {
            id: true,
            plan: true,
            entitlementStatus: true,
            entitlementExpiresAt: true,
          },
        });

        if (!current) {
          throw new NotFoundException('Tenant was not found');
        }

        const mutating =
          input.status !== undefined || input.expiresAt !== undefined;
        const updated = mutating
          ? await transaction.tenant.update({
              where: { id: current.id },
              data: {
                ...(input.status === undefined
                  ? {}
                  : { entitlementStatus: input.status }),
                ...(input.expiresAt === undefined
                  ? {}
                  : { entitlementExpiresAt: input.expiresAt }),
              },
              select: {
                plan: true,
                entitlementStatus: true,
                entitlementExpiresAt: true,
              },
            })
          : current;
        const oldSummary = this.toSummary(
          {
            plan: current.plan,
            status: current.entitlementStatus,
            expiresAt: current.entitlementExpiresAt,
          },
          now
        );
        const newSummary = this.toSummary(
          {
            plan: updated.plan,
            status: updated.entitlementStatus,
            expiresAt: updated.entitlementExpiresAt,
          },
          now
        );

        if (mutating) {
          await transaction.auditLog.create({
            data: {
              id: `aud_${randomUUID()}`,
              tenantId: current.id,
              userId: null,
              action: 'tenant.entitlement.changed',
              entityType: 'Tenant',
              entityId: current.id,
              metadata: {
                operatorContext: 'entitlement:manage',
                correlationId: input.correlationId,
                previousStatus: oldSummary.status,
                newStatus: newSummary.status,
                previousExpiryPresent: oldSummary.expiresAt !== null,
                newExpiryPresent: newSummary.expiresAt !== null,
                effectiveState: newSummary.effectiveState,
              },
            },
            select: { id: true },
          });
        }

        return { oldSummary, newSummary, mutating };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.mutating) {
      this.logger.log('Tenant entitlement changed', {
        event: 'tenant_entitlement_changed',
        tenantFingerprint: this.fingerprint(input.tenantId),
        previousStatus: result.oldSummary.status,
        newStatus: result.newSummary.status,
        previousExpiryPresent: result.oldSummary.expiresAt !== null,
        newExpiryPresent: result.newSummary.expiresAt !== null,
        effectiveState: result.newSummary.effectiveState,
        correlationId: input.correlationId,
        operatorContext: 'entitlement:manage',
      });
    }

    return result.newSummary;
  }

  private toSummary(
    record: TenantEntitlementRecord,
    now: Date
  ): TenantEntitlementSummary {
    return {
      plan: record.plan,
      status: record.status,
      effectiveState: effectiveTenantEntitlementState(record, now),
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
  }

  fingerprint(tenantId: string): string {
    return createHash('sha256').update(tenantId).digest('hex').slice(0, 12);
  }
}
