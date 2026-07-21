import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { MembershipRole } from '@prisma/client';

import type { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { RequireMembership } from '../tenant/decorators/require-membership.decorator';
import { TenantOptional } from '../tenant/decorators/tenant-optional.decorator';
import type { TenantSummary } from '../tenant/tenant-scoped-prisma.service';
import {
  type CreateTenantDto,
  createTenantSchema,
} from './dto/create-tenant.dto';
import {
  type UpdateTenantDto,
  updateTenantSchema,
} from './dto/update-tenant.dto';
import { type CreatedTenant, TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  @TenantOptional()
  createTenant(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new JoiValidationPipe(createTenantSchema)) input: CreateTenantDto
  ): Promise<CreatedTenant> {
    return this.tenants.createTenant(user, input);
  }

  @Get('current')
  @RequireMembership(
    MembershipRole.OWNER,
    MembershipRole.ADMIN,
    MembershipRole.MEMBER
  )
  getCurrentTenant(): Promise<TenantSummary> {
    return this.tenants.getCurrentTenant();
  }

  @Patch('current')
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  updateCurrentTenant(
    @Body(new JoiValidationPipe(updateTenantSchema)) input: UpdateTenantDto
  ): Promise<TenantSummary> {
    return this.tenants.updateCurrentTenant(input);
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireMembership(MembershipRole.OWNER)
  softDeleteCurrentTenant(): Promise<void> {
    return this.tenants.softDeleteCurrentTenant();
  }
}
