import Joi from 'joi';

export interface UpdateUserProfileDto {
  displayName?: string | null;
}

export const updateUserProfileSchema = Joi.object<UpdateUserProfileDto>({
  displayName: Joi.string().trim().min(1).max(255).allow(null),
}).min(1);
