import Joi from 'joi';

export interface RegisterPluginDto {
  token: string;
}

export const registerPluginSchema = Joi.object<RegisterPluginDto>({
  token: Joi.string().trim().min(32).max(256).required(),
});
