import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { MembershipRole } from '@prisma/client';

import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { RequireMembership } from '../tenant/decorators/require-membership.decorator';
import type { MembershipSummary } from '../tenant/tenant-scoped-prisma.service';
import {
  type AddMembershipDto,
  addMembershipSchema,
} from './dto/add-membership.dto';
import {
  membershipIdSchema,
  type UpdateMembershipRoleDto,
  updateMembershipRoleSchema,
} from './dto/update-membership-role.dto';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
@RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  listMemberships(): Promise<MembershipSummary[]> {
    return this.memberships.listMemberships();
  }

  @Post()
  addMembership(
    @Body(new JoiValidationPipe(addMembershipSchema)) input: AddMembershipDto
  ): Promise<MembershipSummary> {
    return this.memberships.addMembership(input);
  }

  @Patch(':membershipId/role')
  updateMembershipRole(
    @Param('membershipId', new JoiValidationPipe(membershipIdSchema))
    membershipId: string,
    @Body(new JoiValidationPipe(updateMembershipRoleSchema))
    input: UpdateMembershipRoleDto
  ): Promise<MembershipSummary> {
    return this.memberships.updateMembershipRole(membershipId, input);
  }

  @Delete(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMembership(
    @Param('membershipId', new JoiValidationPipe(membershipIdSchema))
    membershipId: string
  ): Promise<void> {
    return this.memberships.removeMembership(membershipId);
  }
}
