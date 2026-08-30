import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';

import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { TenantOptional } from '../tenant/decorators/tenant-optional.decorator';
import type { JwtPayload } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  type PublicAuthDto,
  publicLoginSchema,
  publicRegistrationSchema,
} from './dto/public-auth.dto';
import {
  type PublicAuthResult,
  PublicAuthService,
  type TenantContextTokenResult,
} from './public-auth.service';

@Controller('auth')
export class PublicAuthController {
  constructor(private readonly publicAuth: PublicAuthService) {}

  @Post('register')
  @Public()
  register(
    @Body(new JoiValidationPipe(publicRegistrationSchema)) input: PublicAuthDto,
    @Ip() clientIp: string
  ): Promise<PublicAuthResult> {
    return this.publicAuth.register(input, clientIp || 'unknown');
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  login(
    @Body(new JoiValidationPipe(publicLoginSchema)) input: PublicAuthDto,
    @Ip() clientIp: string
  ): Promise<PublicAuthResult> {
    return this.publicAuth.login(input, clientIp || 'unknown');
  }

  @Post('tenant-context')
  @TenantOptional()
  @HttpCode(HttpStatus.OK)
  tenantContext(
    @CurrentUser() user: JwtPayload | undefined
  ): Promise<TenantContextTokenResult> {
    return this.publicAuth.issueTenantContext(user);
  }
}
