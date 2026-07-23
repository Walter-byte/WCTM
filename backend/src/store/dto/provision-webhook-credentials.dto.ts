import Joi from 'joi';

export interface ProvisionWebhookCredentialsDto {
  rotate: boolean;
}

export const provisionWebhookCredentialsSchema =
  Joi.object<ProvisionWebhookCredentialsDto>({
    rotate: Joi.boolean().default(false),
  }).default();
