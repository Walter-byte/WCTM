import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ApplicationConfigService } from '../../config/application-config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_KEY_LENGTH_BYTES = 32;

@Injectable()
export class EncryptionService {
  private readonly currentKey: Buffer;
  private readonly previousKey?: Buffer;

  constructor(configuration: ApplicationConfigService) {
    this.currentKey = this.decodeKey(configuration.encryption.key);
    this.previousKey = configuration.encryption.previousKey
      ? this.decodeKey(configuration.encryption.previousKey)
      : undefined;

    if (this.previousKey && this.currentKey.equals(this.previousKey)) {
      throw new Error(
        'Previous application encryption key must differ from the current key'
      );
    }
  }

  encrypt(plaintext: string): string {
    return this.encryptWithKey(plaintext, this.currentKey);
  }

  decrypt(encryptedValue: string): string {
    const currentPlaintext = this.tryDecryptWithKey(
      encryptedValue,
      this.currentKey
    );

    if (currentPlaintext !== undefined) {
      return currentPlaintext;
    }

    if (this.previousKey) {
      const previousPlaintext = this.tryDecryptWithKey(
        encryptedValue,
        this.previousKey
      );

      if (previousPlaintext !== undefined) {
        return previousPlaintext;
      }
    }

    throw new Error('Unable to decrypt encrypted value');
  }

  hasPreviousKey(): boolean {
    return this.previousKey !== undefined;
  }

  keySource(encryptedValue: string): 'current' | 'previous' | 'unreadable' {
    if (this.tryDecryptWithKey(encryptedValue, this.currentKey) !== undefined) {
      return 'current';
    }

    if (
      this.previousKey &&
      this.tryDecryptWithKey(encryptedValue, this.previousKey) !== undefined
    ) {
      return 'previous';
    }

    return 'unreadable';
  }

  reencryptWithCurrentKey(encryptedValue: string): {
    source: 'current' | 'previous';
    encryptedValue: string;
  } {
    const currentPlaintext = this.tryDecryptWithKey(
      encryptedValue,
      this.currentKey
    );

    if (currentPlaintext !== undefined) {
      return { source: 'current', encryptedValue };
    }

    const plaintext = this.previousKey
      ? this.tryDecryptWithKey(encryptedValue, this.previousKey)
      : undefined;

    if (plaintext === undefined) {
      throw new Error('Unable to re-encrypt encrypted value');
    }

    const reencrypted = this.encryptWithKey(plaintext, this.currentKey);
    const verified = this.tryDecryptWithKey(reencrypted, this.currentKey);

    if (verified !== plaintext) {
      throw new Error('Unable to verify re-encrypted value');
    }

    return {
      source: 'previous',
      encryptedValue: reencrypted,
    };
  }

  private decodeKey(value: string): Buffer {
    const key = Buffer.from(value, 'base64');

    if (key.length !== ENCRYPTION_KEY_LENGTH_BYTES) {
      throw new Error('Application encryption key must decode to 32 bytes');
    }

    return key;
  }

  private encryptWithKey(plaintext: string, key: Buffer): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [iv, authTag, ciphertext]
      .map((component) => component.toString('base64'))
      .join(':');
  }

  private tryDecryptWithKey(
    encryptedValue: string,
    key: Buffer
  ): string | undefined {
    try {
      const components = encryptedValue.split(':');

      if (components.length !== 3) {
        throw new Error('Invalid encrypted value format');
      }

      const [ivValue, authTagValue, ciphertextValue] = components;
      const iv = Buffer.from(ivValue ?? '', 'base64');
      const authTag = Buffer.from(authTagValue ?? '', 'base64');
      const ciphertext = Buffer.from(ciphertextValue ?? '', 'base64');
      if (iv.length !== IV_LENGTH_BYTES || authTag.length !== 16) {
        throw new Error('Invalid encrypted value components');
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv);

      decipher.setAuthTag(authTag);

      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }
}
