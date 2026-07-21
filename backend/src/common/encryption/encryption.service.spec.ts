import { describe, expect, it } from '@jest/globals';

import type { ApplicationConfigService } from '../../config/application-config.service';
import { EncryptionService } from './encryption.service';

function encryptionService(): EncryptionService {
  return new EncryptionService({
    encryption: {
      key: Buffer.alloc(32, 7).toString('base64'),
    },
  } as ApplicationConfigService);
}

describe('EncryptionService', () => {
  it('encrypts and decrypts a value with AES-256-GCM', () => {
    const service = encryptionService();
    const encrypted = service.encrypt('ck_test_value');

    expect(encrypted).not.toContain('ck_test_value');
    expect(encrypted.split(':')).toHaveLength(3);
    expect(service.decrypt(encrypted)).toBe('ck_test_value');
  });

  it('throws when authentication or ciphertext validation fails', () => {
    const service = encryptionService();
    const encrypted = service.encrypt('cs_test_value');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const tamperedCiphertext = Buffer.from(ciphertext ?? '', 'base64');
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
    const tampered = `${iv}:${authTag}:${tamperedCiphertext.toString('base64')}`;

    expect(() => service.decrypt(tampered)).toThrow(
      'Unable to decrypt encrypted value'
    );
  });
});
