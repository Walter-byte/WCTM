import { Body, Controller, Get, Patch } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { TenantOptional } from '../tenant/decorators/tenant-optional.decorator';
import {
  type UpdateUserProfileDto,
  updateUserProfileSchema,
} from './dto/update-user-profile.dto';
import { type UserProfile, UsersService } from './users.service';

@Controller('users')
@TenantOptional()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  getOwnProfile(
    @CurrentUser() user: JwtPayload | undefined
  ): Promise<UserProfile> {
    return this.users.getOwnProfile(user);
  }

  @Patch('me')
  updateOwnProfile(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new JoiValidationPipe(updateUserProfileSchema))
    update: UpdateUserProfileDto
  ): Promise<UserProfile> {
    return this.users.updateOwnProfile(user, update);
  }
}
