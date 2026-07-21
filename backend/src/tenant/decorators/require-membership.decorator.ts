import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';

export const REQUIRED_MEMBERSHIP_ROLES_KEY = 'requiredMembershipRoles';

export const RequireMembership = (
  ...roles: MembershipRole[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_MEMBERSHIP_ROLES_KEY, roles);
