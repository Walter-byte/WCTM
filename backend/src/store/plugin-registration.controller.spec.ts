import { describe, expect, it, jest } from '@jest/globals';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import {
  type RegisterPluginDto,
  registerPluginSchema,
} from './dto/register-plugin.dto';
import { PluginRegistrationController } from './plugin-registration.controller';
import type { StoreRegistrationService } from './store-registration.service';

describe('PluginRegistrationController', () => {
  it('is explicitly public and forwards only token plus resolved client IP', async () => {
    const register = jest.fn().mockResolvedValue({
      pluginCredential: 'plg_once',
      storeId: 'sto_a',
    } as never);
    const confirmPluginConnection = jest
      .fn()
      .mockResolvedValue({ status: 'ACTIVE', healthy: true } as never);
    const controller = new PluginRegistrationController({
      register,
      confirmPluginConnection,
    } as unknown as StoreRegistrationService);

    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        PluginRegistrationController.prototype.register
      )
    ).toBe(true);
    await expect(
      controller.register({ token: `reg_${'a'.repeat(43)}` }, '203.0.113.8')
    ).resolves.toEqual({
      pluginCredential: 'plg_once',
      storeId: 'sto_a',
    });
    expect(register).toHaveBeenCalledWith(
      `reg_${'a'.repeat(43)}`,
      '203.0.113.8'
    );
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        PluginRegistrationController.prototype.connectionHealth
      )
    ).toBe(true);
    await expect(
      controller.connectionHealth(`plg_${'p'.repeat(43)}`)
    ).resolves.toEqual({ status: 'ACTIVE', healthy: true });
    expect(confirmPluginConnection).toHaveBeenCalledWith(
      `plg_${'p'.repeat(43)}`
    );
  });

  it('strips client-supplied tenant and Store identity from the public body', () => {
    const pipe = new JoiValidationPipe(registerPluginSchema);

    expect(
      pipe.transform({
        token: `reg_${'a'.repeat(43)}`,
        tenantId: 'ten_attacker',
        storeId: 'sto_attacker',
      })
    ).toEqual({ token: `reg_${'a'.repeat(43)}` } satisfies RegisterPluginDto);
  });
});
