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

function rotationServices(): {
  oldOnly: EncryptionService;
  dualKey: EncryptionService;
  newOnly: EncryptionService;
} {
  const oldKey = Buffer.alloc(32, 11).toString('base64');
  const newKey = Buffer.alloc(32, 19).toString('base64');

  return {
    oldOnly: new EncryptionService({
      encryption: { key: oldKey },
    } as ApplicationConfigService),
    dualKey: new EncryptionService({
      encryption: { key: newKey, previousKey: oldKey },
    } as ApplicationConfigService),
    newOnly: new EncryptionService({
      encryption: { key: newKey },
    } as ApplicationConfigService),
  };
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

  it('decrypts previous-key ciphertext while writing only with the current key', () => {
    const { oldOnly, dualKey, newOnly } = rotationServices();
    const oldCiphertext = oldOnly.encrypt('synthetic-existing-secret');

    expect(dualKey.keySource(oldCiphertext)).toBe('previous');
    expect(dualKey.decrypt(oldCiphertext)).toBe('synthetic-existing-secret');

    const newCiphertext = dualKey.encrypt('synthetic-new-secret');
    expect(newOnly.decrypt(newCiphertext)).toBe('synthetic-new-secret');
    expect(() => oldOnly.decrypt(newCiphertext)).toThrow(
      'Unable to decrypt encrypted value'
    );
  });

  it('re-encrypts and verifies previous-key ciphertext without exposing plaintext', () => {
    const { oldOnly, dualKey, newOnly } = rotationServices();
    const oldCiphertext = oldOnly.encrypt('synthetic-rotated-secret');
    const result = dualKey.reencryptWithCurrentKey(oldCiphertext);

    expect(result.source).toBe('previous');
    expect(result.encryptedValue).not.toBe(oldCiphertext);
    expect(newOnly.decrypt(result.encryptedValue)).toBe(
      'synthetic-rotated-secret'
    );
    expect(() => oldOnly.decrypt(result.encryptedValue)).toThrow(
      'Unable to decrypt encrypted value'
    );
    expect(dualKey.reencryptWithCurrentKey(result.encryptedValue)).toEqual({
      source: 'current',
      encryptedValue: result.encryptedValue,
    });
  });

  it('rejects equal current and previous keys', () => {
    const key = Buffer.alloc(32, 23).toString('base64');

    expect(
      () =>
        new EncryptionService({
          encryption: { key, previousKey: key },
        } as ApplicationConfigService)
    ).toThrow('Previous application encryption key must differ');
  });
});
