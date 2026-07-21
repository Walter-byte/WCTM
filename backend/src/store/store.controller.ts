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
import type { TenantScopedStore } from '../tenant/tenant-scoped-prisma.service';
import type { WooCommerceConnectionResult } from '../woocommerce/client/woocommerce.client';
import { type CreateStoreDto, createStoreSchema } from './dto/create-store.dto';
import { type UpdateStoreDto, updateStoreSchema } from './dto/update-store.dto';
import { StoreService } from './store.service';

const ALL_MEMBERSHIP_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

@Controller('stores')
export class StoreController {
  constructor(private readonly stores: StoreService) {}

  @Post()
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  create(
    @Body(new JoiValidationPipe(createStoreSchema)) input: CreateStoreDto
  ): Promise<TenantScopedStore> {
    return this.stores.create(input);
  }

  @Get()
  @RequireMembership(...ALL_MEMBERSHIP_ROLES)
  findAll(): Promise<TenantScopedStore[]> {
    return this.stores.findAll();
  }

  @Get(':id')
  @RequireMembership(...ALL_MEMBERSHIP_ROLES)
  findOne(@Param('id') storeId: string): Promise<TenantScopedStore> {
    return this.stores.findOne(storeId);
  }

  @Patch(':id')
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  update(
    @Param('id') storeId: string,
    @Body(new JoiValidationPipe(updateStoreSchema)) input: UpdateStoreDto
  ): Promise<TenantScopedStore> {
    return this.stores.update(storeId, input);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  softDelete(@Param('id') storeId: string): Promise<void> {
    return this.stores.softDelete(storeId);
  }

  @Post(':id/test-connection')
  @RequireMembership(...ALL_MEMBERSHIP_ROLES)
  testConnection(
    @Param('id') storeId: string
  ): Promise<WooCommerceConnectionResult> {
    return this.stores.testConnection(storeId);
  }
}
