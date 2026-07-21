import Joi from 'joi';

export interface UpdateTenantDto {
  name: string;
}

export const updateTenantSchema = Joi.object<UpdateTenantDto>({
  name: Joi.string().trim().min(1).max(255).required(),
});
