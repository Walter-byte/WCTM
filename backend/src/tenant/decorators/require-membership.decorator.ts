import { SetMetadata } from '@nestjs/common';

export const REQUIRED_MEMBERSHIP_ROLES_KEY = 'requiredMembershipRoles';

export const RequireMembership = (
  ...roles: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_MEMBERSHIP_ROLES_KEY, roles);
