import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ApplicationConfigService } from '../../config/application-config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_KEY_LENGTH_BYTES = 32;

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(configuration: ApplicationConfigService) {
    this.key = Buffer.from(configuration.encryption.key, 'base64');

    if (this.key.length !== ENCRYPTION_KEY_LENGTH_BYTES) {
      throw new Error('Application encryption key must decode to 32 bytes');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [iv, authTag, ciphertext]
      .map((component) => component.toString('base64'))
      .join(':');
  }

  decrypt(encryptedValue: string): string {
    try {
      const components = encryptedValue.split(':');

      if (components.length !== 3) {
        throw new Error('Invalid encrypted value format');
      }

      const [ivValue, authTagValue, ciphertextValue] = components;
      const iv = Buffer.from(ivValue ?? '', 'base64');
      const authTag = Buffer.from(authTagValue ?? '', 'base64');
      const ciphertext = Buffer.from(ciphertextValue ?? '', 'base64');
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);

      decipher.setAuthTag(authTag);

      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Unable to decrypt encrypted value');
    }
  }
}
