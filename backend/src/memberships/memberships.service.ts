import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import {
  type MembershipSummary,
  TenantScopedPrismaService,
} from '../tenant/tenant-scoped-prisma.service';
import type { AddMembershipDto } from './dto/add-membership.dto';
import type { UpdateMembershipRoleDto } from './dto/update-membership-role.dto';

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantPrisma: TenantScopedPrismaService
  ) {}

  listMemberships(): Promise<MembershipSummary[]> {
    this.assertManagementRole();
    return this.tenantPrisma.listActiveMemberships();
  }

  async addMembership(input: AddMembershipDto): Promise<MembershipSummary> {
    const actorRole = this.assertManagementRole();
    this.assertRoleAssignmentAllowed(actorRole, input.role);

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('User was not found');
    }

    const existing = await this.tenantPrisma.findMembershipRecordByUserId(
      input.userId
    );

    if (existing && existing.deletedAt === null) {
      throw new ConflictException('User already has an active membership');
    }

    let membershipId: string;

    if (existing) {
      membershipId = existing.id;
      const reactivated = await this.tenantPrisma.reactivateMembership(
        membershipId,
        input.role
      );

      if (!reactivated) {
        throw new ConflictException('Membership changed; retry the request');
      }
    } else {
      membershipId = `mem_${randomUUID()}`;
      await this.tenantPrisma.createMembership(
        membershipId,
        input.userId,
        input.role
      );
    }

    return this.requireActiveMembership(membershipId);
  }

  async updateMembershipRole(
    membershipId: string,
    input: UpdateMembershipRoleDto
  ): Promise<MembershipSummary> {
    const { tenantId } = this.tenantContext.active;
    const actorRole = this.assertManagementRole();

    await this.prisma.$transaction(
      async (transaction) => {
        const membership = await transaction.membership.findFirst({
          where: {
            id: membershipId,
            tenantId,
            deletedAt: null,
            tenant: { deletedAt: null },
          },
          select: { id: true, role: true },
        });

        if (!membership) {
          throw new NotFoundException('Membership was not found');
        }

        this.assertTargetManagementAllowed(
          actorRole,
          membership.role,
          input.role
        );

        if (
          membership.role === MembershipRole.OWNER &&
          input.role !== MembershipRole.OWNER
        ) {
          await this.assertAnotherOwnerExists(transaction, tenantId);
        }

        if (membership.role === input.role) {
          return;
        }

        const result = await transaction.membership.updateMany({
          where: {
            id: membershipId,
            tenantId,
            deletedAt: null,
            role: membership.role,
          },
          data: { role: input.role },
        });

        if (result.count !== 1) {
          throw new ConflictException('Membership changed; retry the request');
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return this.requireActiveMembership(membershipId);
  }

  async removeMembership(membershipId: string): Promise<void> {
    const { tenantId } = this.tenantContext.active;
    const actorRole = this.assertManagementRole();

    await this.prisma.$transaction(
      async (transaction) => {
        const membership = await transaction.membership.findFirst({
          where: {
            id: membershipId,
            tenantId,
            deletedAt: null,
            tenant: { deletedAt: null },
          },
          select: { id: true, role: true },
        });

        if (!membership) {
          throw new NotFoundException('Membership was not found');
        }

        this.assertTargetManagementAllowed(actorRole, membership.role);

        if (membership.role === MembershipRole.OWNER) {
          await this.assertAnotherOwnerExists(transaction, tenantId);
        }

        const result = await transaction.membership.updateMany({
          where: {
            id: membershipId,
            tenantId,
            deletedAt: null,
            role: membership.role,
          },
          data: { deletedAt: new Date() },
        });

        if (result.count !== 1) {
          throw new ConflictException('Membership changed; retry the request');
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private assertManagementRole(): MembershipRole {
    const role = this.tenantContext.active.membershipRole;

    if (role === MembershipRole.OWNER || role === MembershipRole.ADMIN) {
      return role;
    }

    throw new ForbiddenException('Membership management is not permitted');
  }

  private assertRoleAssignmentAllowed(
    actorRole: MembershipRole,
    assignedRole: MembershipRole
  ): void {
    if (
      actorRole === MembershipRole.ADMIN &&
      assignedRole === MembershipRole.OWNER
    ) {
      throw new ForbiddenException('Only an owner can assign the owner role');
    }
  }

  private assertTargetManagementAllowed(
    actorRole: MembershipRole,
    targetRole: MembershipRole,
    assignedRole?: MembershipRole
  ): void {
    if (
      actorRole === MembershipRole.ADMIN &&
      (targetRole === MembershipRole.OWNER ||
        assignedRole === MembershipRole.OWNER)
    ) {
      throw new ForbiddenException('An admin cannot manage owner memberships');
    }
  }

  private async assertAnotherOwnerExists(
    transaction: Prisma.TransactionClient,
    tenantId: string
  ): Promise<void> {
    const ownerCount = await transaction.membership.count({
      where: {
        tenantId,
        role: MembershipRole.OWNER,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
    });

    if (ownerCount <= 1) {
      throw new ConflictException(
        'The last remaining owner cannot be removed or demoted'
      );
    }
  }

  private async requireActiveMembership(
    membershipId: string
  ): Promise<MembershipSummary> {
    const membership =
      await this.tenantPrisma.findActiveMembershipById(membershipId);

    if (!membership) {
      throw new NotFoundException('Membership was not found');
    }

    return membership;
  }
}
