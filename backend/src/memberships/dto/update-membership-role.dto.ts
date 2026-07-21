import { MembershipRole } from '@prisma/client';
import Joi from 'joi';

export interface UpdateMembershipRoleDto {
  role: MembershipRole;
}

export const updateMembershipRoleSchema = Joi.object<UpdateMembershipRoleDto>({
  role: Joi.string()
    .valid(...Object.values(MembershipRole))
    .required(),
});

export const membershipIdSchema = Joi.string().trim().min(1).max(64).required();
