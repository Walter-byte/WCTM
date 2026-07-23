import Joi from 'joi';

const MAX_SIGNED_BIGINT = BigInt('9223372036854775807');
const decimalIdentifier = Joi.string()
  .pattern(/^[1-9]\d*$/)
  .max(19)
  .custom((value: string, helpers: Joi.CustomHelpers) =>
    BigInt(value) <= MAX_SIGNED_BIGINT ? value : helpers.error('number.max')
  );

export interface TelegramRedeemDto {
  telegramUserId: string;
  telegramChatId: string;
  chatType: 'private';
  token: string;
  updateId: string;
}

export interface TelegramStatusDto {
  telegramUserId: string;
  telegramChatId: string;
  updateId: string;
}

export interface TelegramUnlinkDto extends TelegramStatusDto {
  confirmed: boolean;
}

export const telegramRedeemSchema = Joi.object<TelegramRedeemDto>({
  telegramUserId: decimalIdentifier.required(),
  telegramChatId: decimalIdentifier.required(),
  chatType: Joi.string().valid('private').required(),
  token: Joi.string().trim().min(32).max(256).required(),
  updateId: decimalIdentifier.required(),
});

export const telegramStatusSchema = Joi.object<TelegramStatusDto>({
  telegramUserId: decimalIdentifier.required(),
  telegramChatId: decimalIdentifier.required(),
  updateId: decimalIdentifier.required(),
});

export const telegramUnlinkSchema = Joi.object<TelegramUnlinkDto>({
  telegramUserId: decimalIdentifier.required(),
  telegramChatId: decimalIdentifier.required(),
  confirmed: Joi.boolean().strict().required(),
  updateId: decimalIdentifier.required(),
});
