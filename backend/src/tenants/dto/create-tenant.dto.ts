import Joi from 'joi';

export interface CreateTenantDto {
  name: string;
}

export const createTenantSchema = Joi.object<CreateTenantDto>({
  name: Joi.string().trim().min(1).max(255).required(),
});
