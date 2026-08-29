import { describe, expect, it, jest } from '@jest/globals';

import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import {
  type PublicAuthDto,
  publicLoginSchema,
  publicRegistrationSchema,
} from './dto/public-auth.dto';
import { PublicAuthController } from './public-auth.controller';
import type { PublicAuthService } from './public-auth.service';

describe('PublicAuthController', () => {
  it('marks registration and login public and forwards only validated credentials and IP', async () => {
    const result = {
      accessToken: 'jwt-value',
      user: {
        id: 'usr_a',
        email: 'user@example.com',
        displayName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    const register = jest.fn().mockResolvedValue(result as never);
    const login = jest.fn().mockResolvedValue(result as never);
    const controller = new PublicAuthController({
      register,
      login,
    } as unknown as PublicAuthService);

    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        PublicAuthController.prototype.register
      )
    ).toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, PublicAuthController.prototype.login)
    ).toBe(true);

    const input = {
      email: 'user@example.com',
      password: 'valid-password-value',
    };
    await expect(controller.register(input, '203.0.113.5')).resolves.toBe(
      result
    );
    await expect(controller.login(input, '')).resolves.toBe(result);
    expect(register).toHaveBeenCalledWith(input, '203.0.113.5');
    expect(login).toHaveBeenCalledWith(input, 'unknown');
  });

  it('rejects invalid credentials and strips unrelated identity fields', () => {
    const registrationPipe = new JoiValidationPipe(publicRegistrationSchema);
    const loginPipe = new JoiValidationPipe(publicLoginSchema);

    expect(() =>
      registrationPipe.transform({
        email: 'not-an-email',
        password: 'short',
      })
    ).toThrow('Bad Request');
    expect(
      loginPipe.transform({
        email: ' User@Example.COM ',
        password: 'valid-password-value',
        tenantId: 'ten_attacker',
        passwordHash: 'attacker-hash',
      })
    ).toEqual({
      email: 'User@Example.COM',
      password: 'valid-password-value',
    } satisfies PublicAuthDto);
  });
});
