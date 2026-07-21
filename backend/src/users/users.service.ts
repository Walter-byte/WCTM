import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { JwtPayload } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateUserProfileDto } from './dto/update-user-profile.dto';

const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  displayName: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type UserProfile = Prisma.UserGetPayload<{
  select: typeof USER_PROFILE_SELECT;
}>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnProfile(payload: JwtPayload | undefined): Promise<UserProfile> {
    const userId = this.authenticatedUserId(payload);
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_PROFILE_SELECT,
    });

    if (!profile) {
      throw new NotFoundException('Authenticated user was not found');
    }

    return profile;
  }

  async updateOwnProfile(
    payload: JwtPayload | undefined,
    update: UpdateUserProfileDto
  ): Promise<UserProfile> {
    const userId = this.authenticatedUserId(payload);
    const result = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { displayName: update.displayName },
    });

    if (result.count !== 1) {
      throw new NotFoundException('Authenticated user was not found');
    }

    return this.getOwnProfile(payload);
  }

  private authenticatedUserId(payload: JwtPayload | undefined): string {
    const userId = payload?.['sub'];

    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new UnauthorizedException('Authenticated user subject is required');
    }

    return userId;
  }
}
