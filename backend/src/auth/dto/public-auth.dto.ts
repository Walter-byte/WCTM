import Joi from 'joi';

export interface PublicAuthDto {
  email: string;
  password: string;
}

const emailSchema = Joi.string()
  .trim()
  .email({ tlds: { allow: false } })
  .max(320)
  .required();
const passwordSchema = Joi.string().min(12).max(128).required();

export const publicRegistrationSchema = Joi.object<PublicAuthDto>({
  email: emailSchema,
  password: passwordSchema,
});

export const publicLoginSchema = Joi.object<PublicAuthDto>({
  email: emailSchema,
  password: passwordSchema,
});
