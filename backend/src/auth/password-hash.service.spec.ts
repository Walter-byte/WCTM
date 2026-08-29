import { beforeAll, describe, expect, it } from '@jest/globals';

import { PasswordHashService } from './password-hash.service';

describe('PasswordHashService', () => {
  const service = new PasswordHashService();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('persists Argon2id hashes and verifies without exposing plaintext', async () => {
    const password = 'correct horse battery staple';
    const passwordHash = await service.hash(password);

    expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(passwordHash).not.toContain(password);
    await expect(service.matches(passwordHash, password)).resolves.toBe(true);
    await expect(
      service.matches(passwordHash, 'wrong password value')
    ).resolves.toBe(false);
  });

  it('uses the bounded dummy verification path for missing or invalid hashes', async () => {
    await expect(
      service.matches(null, 'unknown account password')
    ).resolves.toBe(false);
    await expect(
      service.matches('not-an-argon-hash', 'invalid hash password')
    ).resolves.toBe(false);
  });
});
