import { describe, expect, it } from '@jest/globals';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { OnboardingController } from './onboarding.controller';

describe('OnboardingController', () => {
  it('serves the restrained surface publicly without returning runtime secrets', () => {
    const controller = new OnboardingController();

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, OnboardingController)).toBe(true);
    expect(controller.page()).toContain('Connect WooCommerce to Telegram');
    expect(controller.javascript()).not.toMatch(/localStorage|console\./);
    expect(controller.styles()).toContain('[hidden]');
  });
});
