import { describe, expect, it } from '@jest/globals';

import { approvedPublicHttpsOrigin } from './pilot-url';

describe('approvedPublicHttpsOrigin', () => {
  it('accepts only a public HTTPS origin', () => {
    expect(approvedPublicHttpsOrigin('https://pilot.example.com')).toBe(
      'https://pilot.example.com'
    );
  });

  it.each([
    'http://pilot.example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.2',
    'https://172.16.0.2',
    'https://192.168.1.2',
    'https://[::1]',
    'https://pilot.internal',
    'https://pilot.example.com/path',
  ])('refuses a non-public webhook base URL: %s', (value) => {
    expect(() => approvedPublicHttpsOrigin(value)).toThrow(
      /approved public HTTPS origin/
    );
  });
});
