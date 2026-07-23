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
import {
  type ProvisionWebhookCredentialsDto,
  provisionWebhookCredentialsSchema,
} from './dto/provision-webhook-credentials.dto';
import { type UpdateStoreDto, updateStoreSchema } from './dto/update-store.dto';
import { StoreService } from './store.service';
import {
  type RegistrationTokenResult,
  type StoreConnectionHealthResult,
  StoreRegistrationService,
  type WebhookCredentialsResult,
} from './store-registration.service';

const ALL_MEMBERSHIP_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

@Controller('stores')
export class StoreController {
  constructor(
    private readonly stores: StoreService,
    private readonly registration: StoreRegistrationService
  ) {}

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

  @Post(':id/registration-token')
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  issueRegistrationToken(
    @Param('id') storeId: string
  ): Promise<RegistrationTokenResult> {
    return this.registration.issueToken(storeId);
  }

  @Post(':id/webhook-credentials')
  @RequireMembership(MembershipRole.OWNER, MembershipRole.ADMIN)
  provisionWebhookCredentials(
    @Param('id') storeId: string,
    @Body(new JoiValidationPipe(provisionWebhookCredentialsSchema))
    input: ProvisionWebhookCredentialsDto
  ): Promise<WebhookCredentialsResult> {
    return this.registration.provisionWebhookCredentials(storeId, input.rotate);
  }

  @Get(':id/connection-health')
  @RequireMembership(...ALL_MEMBERSHIP_ROLES)
  connectionHealth(
    @Param('id') storeId: string
  ): Promise<StoreConnectionHealthResult> {
    return this.registration.connectionHealth(storeId);
  }
}
