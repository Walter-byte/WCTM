import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma, StoreStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../tenant/tenant-context.service';

const SAFE_CHANGED_FIELDS = new Set(['name', 'storeUrl']);
const SAFE_ROLES = new Set(Object.values(MembershipRole));
const SAFE_STORE_STATUSES = new Set(Object.values(StoreStatus));

export interface AuditEvent {
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

function safeAuditMetadata(
  metadata: Record<string, unknown> | undefined
): Prisma.InputJsonObject | undefined {
  if (!metadata) {
    return undefined;
  }

  const safe: Record<string, Prisma.InputJsonValue> = {};
  const role = metadata['role'];
  const previousRole = metadata['previousRole'];
  const newRole = metadata['newRole'];
  const reactivated = metadata['reactivated'];
  const status = metadata['status'];
  const success = metadata['success'];
  const credentialsChanged = metadata['credentialsChanged'];
  const rotated = metadata['rotated'];
  const changedFields = metadata['changedFields'];

  if (typeof role === 'string' && SAFE_ROLES.has(role as MembershipRole)) {
    safe['role'] = role;
  }

  if (
    typeof previousRole === 'string' &&
    SAFE_ROLES.has(previousRole as MembershipRole)
  ) {
    safe['previousRole'] = previousRole;
  }

  if (
    typeof newRole === 'string' &&
    SAFE_ROLES.has(newRole as MembershipRole)
  ) {
    safe['newRole'] = newRole;
  }

  if (typeof reactivated === 'boolean') {
    safe['reactivated'] = reactivated;
  }

  if (
    typeof status === 'string' &&
    SAFE_STORE_STATUSES.has(status as StoreStatus)
  ) {
    safe['status'] = status;
  }

  if (typeof success === 'boolean') {
    safe['success'] = success;
  }

  if (typeof credentialsChanged === 'boolean') {
    safe['credentialsChanged'] = credentialsChanged;
  }

  if (typeof rotated === 'boolean') {
    safe['rotated'] = rotated;
  }

  if (Array.isArray(changedFields)) {
    safe['changedFields'] = changedFields.filter(
      (field): field is string =>
        typeof field === 'string' && SAFE_CHANGED_FIELDS.has(field)
    );
  }

  return Object.keys(safe).length === 0 ? undefined : safe;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  async record(event: AuditEvent): Promise<void> {
    const { tenantId, userId: actorUserId } = this.tenantContext.active;
    const metadata = safeAuditMetadata(event.metadata);

    await this.prisma.auditLog.create({
      data: {
        id: `aud_${randomUUID()}`,
        tenantId,
        userId: actorUserId,
        action: event.action,
        entityType: event.entity,
        ...(event.entityId ? { entityId: event.entityId } : {}),
        ...(metadata ? { metadata } : {}),
      },
      select: { id: true },
    });
  }
}
