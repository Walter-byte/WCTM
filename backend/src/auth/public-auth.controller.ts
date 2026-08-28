import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';

import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { Public } from './decorators/public.decorator';
import {
  type PublicAuthDto,
  publicLoginSchema,
  publicRegistrationSchema,
} from './dto/public-auth.dto';
import {
  type PublicAuthResult,
  PublicAuthService,
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
}
