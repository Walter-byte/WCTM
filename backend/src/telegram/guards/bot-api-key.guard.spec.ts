import { describe, expect, it } from '@jest/globals';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { ApplicationConfigService } from '../../config/application-config.service';
import { BotApiKeyGuard } from './bot-api-key.guard';

function context(value?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: value ? { 'x-bot-api-key': value } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('BotApiKeyGuard', () => {
  const configuration = {
    telegram: { internalApiKey: 'test-internal-key' },
  } as ApplicationConfigService;
  const guard = new BotApiKeyGuard(configuration);

  it('accepts the configured internal bot credential', () => {
    expect(guard.canActivate(context('test-internal-key'))).toBe(true);
  });

  it.each([undefined, 'wrong-key'])(
    'rejects a missing or wrong credential',
    (value) => {
      expect(() => guard.canActivate(context(value))).toThrow(
        UnauthorizedException
      );
    }
  );
});
