import Joi from 'joi';

export interface UpdateStoreDto {
  name?: string;
  storeUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
}

export const updateStoreSchema = Joi.object<UpdateStoreDto>({
  name: Joi.string().trim().min(1).max(100).optional(),
  storeUrl: Joi.string()
    .trim()
    .uri({ scheme: ['https'] })
    .optional(),
  consumerKey: Joi.string().min(1).optional(),
  consumerSecret: Joi.string().min(1).optional(),
});
