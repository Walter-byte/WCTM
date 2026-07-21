import { MembershipRole } from '@prisma/client';
import Joi from 'joi';

export interface AddMembershipDto {
  userId: string;
  role: MembershipRole;
}

export const addMembershipSchema = Joi.object<AddMembershipDto>({
  userId: Joi.string().trim().min(1).max(64).required(),
  role: Joi.string()
    .valid(...Object.values(MembershipRole))
    .default(MembershipRole.MEMBER),
});
