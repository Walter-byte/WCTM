import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import {
  type RegisterPluginDto,
  registerPluginSchema,
} from './dto/register-plugin.dto';
import {
  type PluginConnectionHealthResult,
  type PluginRegistrationResult,
  StoreRegistrationService,
} from './store-registration.service';

@Controller('plugin')
export class PluginRegistrationController {
  constructor(private readonly registration: StoreRegistrationService) {}

  @Post('register')
  @Public()
  @HttpCode(HttpStatus.OK)
  register(
    @Body(new JoiValidationPipe(registerPluginSchema)) input: RegisterPluginDto,
    @Ip() clientIp: string
  ): Promise<PluginRegistrationResult> {
    return this.registration.register(input.token, clientIp || 'unknown');
  }

  @Post('connection-health')
  @Public()
  @HttpCode(HttpStatus.OK)
  connectionHealth(
    @Headers('x-wctm-plugin-credential') pluginCredential?: string
  ): Promise<PluginConnectionHealthResult> {
    if (!pluginCredential || pluginCredential.length > 256) {
      return this.registration.confirmPluginConnection('invalid');
    }

    return this.registration.confirmPluginConnection(pluginCredential);
  }
}
