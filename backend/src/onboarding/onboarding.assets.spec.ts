import { describe, expect, it } from '@jest/globals';

import { ONBOARDING_HTML, ONBOARDING_JAVASCRIPT } from './onboarding.assets';

describe('M16 onboarding surface', () => {
  it('contains valid browser JavaScript', () => {
    expect(() => new Function(ONBOARDING_JAVASCRIPT)).not.toThrow();
  });

  it('uses only the approved same-origin API ceremony', () => {
    expect(ONBOARDING_JAVASCRIPT).toContain("fetch('/api' + path");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/auth/' + authMode");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/auth/tenant-context'");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/tenants'");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/stores'");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/registration-token'");
    expect(ONBOARDING_JAVASCRIPT).toContain("'/internal/telegram/link-tokens'");
    expect(ONBOARDING_JAVASCRIPT).not.toContain('webhook-credentials');
    expect(ONBOARDING_JAVASCRIPT).not.toMatch(/pilot:setup|\bSQL\b/i);
  });

  it('keeps JWTs and submitted credentials in memory and out of URLs and logs', () => {
    expect(ONBOARDING_JAVASCRIPT).not.toMatch(/localStorage|sessionStorage/);
    expect(ONBOARDING_JAVASCRIPT).not.toMatch(/console\./);
    expect(ONBOARDING_JAVASCRIPT).toContain(
      "headers.Authorization = 'Bearer ' + token"
    );
    expect(ONBOARDING_JAVASCRIPT).toContain(
      "form.elements.password.value = ''"
    );
    expect(ONBOARDING_JAVASCRIPT).toContain("body.consumerKey = ''");
    expect(ONBOARDING_JAVASCRIPT).toContain("body.consumerSecret = ''");
    expect(ONBOARDING_JAVASCRIPT).not.toMatch(
      /[?&](token|accessToken|consumerKey|consumerSecret|pluginCredential|webhookSecret)=/
    );
    expect(ONBOARDING_HTML).toContain(
      '<meta name="referrer" content="no-referrer">'
    );
  });

  it('exposes Telegram linking only after ACTIVE health is observed', () => {
    const usabilityCheck =
      "health.status === 'ACTIVE' && Boolean(health.lastHealthyAt)";
    expect(ONBOARDING_JAVASCRIPT).toContain(usabilityCheck);
    expect(ONBOARDING_JAVASCRIPT.indexOf(usabilityCheck)).toBeLessThan(
      ONBOARDING_JAVASCRIPT.indexOf("show('telegram-step', usable)")
    );
  });

  it('renders a safe inactive-entitlement onboarding boundary', () => {
    expect(ONBOARDING_JAVASCRIPT).toContain(
      "data?.code === 'ENTITLEMENT_INACTIVE'"
    );
    expect(ONBOARDING_JAVASCRIPT).toContain(
      'Service access is inactive. Store registration and Telegram linking are unavailable'
    );
  });
});
