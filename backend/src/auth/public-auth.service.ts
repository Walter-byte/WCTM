import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { PublicAuthDto } from './dto/public-auth.dto';
import { PasswordHashService } from './password-hash.service';
import {
  authIdentifierFingerprint,
  normalizeEmail,
} from './public-auth-identifiers';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type PublicUser = Prisma.UserGetPayload<{
  select: typeof PUBLIC_USER_SELECT;
}>;

interface CredentialUser extends PublicUser {
  passwordHash: string | null;
}

export interface PublicAuthResult {
  accessToken: string;
  user: PublicUser;
}

@Injectable()
export class PublicAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly passwordHashes: PasswordHashService,
    private readonly rateLimiter: PublicAuthRateLimiter,
    private readonly logger: StructuredLoggerService
  ) {}

  async register(
    input: PublicAuthDto,
    clientIp: string
  ): Promise<PublicAuthResult> {
    const normalizedEmail = normalizeEmail(input.email);
    await this.rateLimiter.assertRegistrationAllowed(clientIp, normalizedEmail);

    if (await this.findCredentialUser(normalizedEmail)) {
      this.logRejected('register', clientIp, normalizedEmail);
      throw new ConflictException(
        'Account registration could not be completed'
      );
    }

    const passwordHash = await this.passwordHashes.hash(input.password);
    let user: PublicUser;

    try {
      user = await this.prisma.user.create({
        data: {
          id: `usr_${randomUUID()}`,
          email: normalizedEmail,
          passwordHash,
        },
        select: PUBLIC_USER_SELECT,
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) {
        this.logRejected('register', clientIp, normalizedEmail);
        throw new ConflictException(
          'Account registration could not be completed'
        );
      }

      throw error;
    }

    const accessToken = await this.auth.signAccessToken({ sub: user.id });
    this.logSucceeded('register', clientIp, normalizedEmail, user.id);

    return { accessToken, user };
  }

  async login(
    input: PublicAuthDto,
    clientIp: string
  ): Promise<PublicAuthResult> {
    const normalizedEmail = normalizeEmail(input.email);
    await this.rateLimiter.assertLoginAllowed(clientIp, normalizedEmail);

    const credentialUser = await this.findCredentialUser(normalizedEmail);
    const authenticated = await this.passwordHashes.matches(
      credentialUser?.passwordHash ?? null,
      input.password
    );

    if (!credentialUser || !authenticated) {
      this.logRejected('login', clientIp, normalizedEmail);
      throw new UnauthorizedException('Invalid email or password');
    }

    const user: PublicUser = {
      id: credentialUser.id,
      email: credentialUser.email,
      displayName: credentialUser.displayName,
      createdAt: credentialUser.createdAt,
      updatedAt: credentialUser.updatedAt,
    };
    const accessToken = await this.auth.signAccessToken({ sub: user.id });
    this.logSucceeded('login', clientIp, normalizedEmail, user.id);

    return { accessToken, user };
  }

  private async findCredentialUser(
    normalizedEmail: string
  ): Promise<CredentialUser | null> {
    const users = await this.prisma.$queryRaw<CredentialUser[]>(Prisma.sql`
      SELECT
        "id",
        "email",
        "display_name" AS "displayName",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt",
        "password_hash" AS "passwordHash"
      FROM "users"
      WHERE lower(btrim("email")) = ${normalizedEmail}
      LIMIT 1
    `);

    return users[0] ?? null;
  }

  private isUniqueConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private logRejected(
    operation: 'register' | 'login',
    clientIp: string,
    normalizedEmail: string
  ): void {
    this.logger.warn(
      'Public account authentication rejected',
      {
        operation,
        clientIpFingerprint: authIdentifierFingerprint(clientIp),
        emailFingerprint: authIdentifierFingerprint(normalizedEmail),
      },
      PublicAuthService.name
    );
  }

  private logSucceeded(
    operation: 'register' | 'login',
    clientIp: string,
    normalizedEmail: string,
    userId: string
  ): void {
    this.logger.log(
      'Public account authentication succeeded',
      {
        operation,
        userId,
        clientIpFingerprint: authIdentifierFingerprint(clientIp),
        emailFingerprint: authIdentifierFingerprint(normalizedEmail),
      },
      PublicAuthService.name
    );
  }
}
