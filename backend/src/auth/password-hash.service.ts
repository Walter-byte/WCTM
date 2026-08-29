import { Injectable, type OnModuleInit } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});
const DUMMY_PASSWORD = 'wctm-public-auth-dummy-password';

@Injectable()
export class PasswordHashService implements OnModuleInit {
  private dummyHash?: string;

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(DUMMY_PASSWORD);
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2ID_OPTIONS);
  }

  async matches(
    passwordHash: string | null,
    password: string
  ): Promise<boolean> {
    const dummyHash = this.requiredDummyHash();
    const candidateHash = passwordHash ?? dummyHash;

    try {
      const matches = await verify(candidateHash, password);

      return passwordHash !== null && matches;
    } catch {
      if (passwordHash !== null) {
        await verify(dummyHash, password);
      }

      return false;
    }
  }

  private requiredDummyHash(): string {
    if (!this.dummyHash) {
      throw new Error('Password verification is not initialized');
    }

    return this.dummyHash;
  }
}
