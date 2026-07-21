import Joi from 'joi';

export interface CreateStoreDto {
  name: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export const createStoreSchema = Joi.object<CreateStoreDto>({
  name: Joi.string().trim().min(1).max(100).required(),
  storeUrl: Joi.string()
    .trim()
    .uri({ scheme: ['https'] })
    .required(),
  consumerKey: Joi.string().min(1).required(),
  consumerSecret: Joi.string().min(1).required(),
});
