import Joi from 'joi';

const MAX_SIGNED_BIGINT = BigInt('9223372036854775807');
const decimalIdentifier = Joi.string()
  .pattern(/^[1-9]\d*$/)
  .max(19)
  .custom((value: string, helpers: Joi.CustomHelpers) =>
    BigInt(value) <= MAX_SIGNED_BIGINT ? value : helpers.error('number.max')
  );
const callbackReference = Joi.string()
  .pattern(/^[cdgikpsv]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/)
  .max(64);
export const TELEGRAM_ORDER_NOTE_MAX_LENGTH = 1000;

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

export interface TelegramOrderIdentityDto {
  userId: string;
  chatId: string;
}

export interface TelegramOrderListDto {
  telegram: TelegramOrderIdentityDto;
  cursor?: string;
}

export interface TelegramOrderDetailDto {
  telegram: TelegramOrderIdentityDto;
  ref: string;
}

export interface TelegramOrderLookupDto {
  telegram: TelegramOrderIdentityDto;
  orderNumber: string;
}

export interface TelegramStockListDto {
  telegram: TelegramOrderIdentityDto;
  cursor?: string;
}

export interface TelegramStockDetailDto {
  telegram: TelegramOrderIdentityDto;
  ref: string;
}

export interface TelegramOrderNoteStartDto extends TelegramOrderDetailDto {
  visibility: 'INTERNAL' | 'CUSTOMER';
}

export interface TelegramOrderNotePrepareDto extends TelegramOrderDetailDto {
  note: string;
}

export type TelegramOrderTransitionsDto = TelegramOrderDetailDto;

export interface TelegramOrderStatusUpdateDto extends TelegramOrderDetailDto {
  target: string;
}

export interface TelegramSettingsSummaryDto {
  telegram: TelegramOrderIdentityDto;
}

export interface TelegramSettingsReferenceDto extends TelegramSettingsSummaryDto {
  ref: string;
}

export interface TelegramSettingsInputDto extends TelegramSettingsReferenceDto {
  value: string;
}

export const telegramRedeemSchema = Joi.object<TelegramRedeemDto>({
  telegramUserId: decimalIdentifier.required(),
  telegramChatId: decimalIdentifier.required(),
  chatType: Joi.string().valid('private').required(),
  token: Joi.string()
    .trim()
    .pattern(/^tgl_[A-Za-z0-9_-]{43}$/)
    .required(),
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

const telegramOrderIdentitySchema = Joi.object<TelegramOrderIdentityDto>({
  userId: decimalIdentifier.required(),
  chatId: decimalIdentifier.required(),
}).required();

export const telegramOrderListSchema = Joi.object<TelegramOrderListDto>({
  telegram: telegramOrderIdentitySchema,
  cursor: callbackReference.optional(),
});

export const telegramOrderDetailSchema = Joi.object<TelegramOrderDetailDto>({
  telegram: telegramOrderIdentitySchema,
  ref: callbackReference.required(),
});

export const telegramOrderLookupSchema = Joi.object<TelegramOrderLookupDto>({
  telegram: telegramOrderIdentitySchema,
  orderNumber: Joi.string().allow('').max(191).required(),
});

export const telegramStockListSchema = Joi.object<TelegramStockListDto>({
  telegram: telegramOrderIdentitySchema,
  cursor: callbackReference.optional(),
});

export const telegramStockDetailSchema = Joi.object<TelegramStockDetailDto>({
  telegram: telegramOrderIdentitySchema,
  ref: callbackReference.required(),
});

export const telegramOrderNoteStartSchema =
  Joi.object<TelegramOrderNoteStartDto>({
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
    visibility: Joi.string().valid('INTERNAL', 'CUSTOMER').required(),
  });

export const telegramOrderNotePrepareSchema =
  Joi.object<TelegramOrderNotePrepareDto>({
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
    note: Joi.string().allow('').max(TELEGRAM_ORDER_NOTE_MAX_LENGTH).required(),
  });

export const telegramOrderTransitionsSchema =
  Joi.object<TelegramOrderTransitionsDto>({
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
  });

export const telegramOrderStatusUpdateSchema =
  Joi.object<TelegramOrderStatusUpdateDto>({
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
    target: Joi.string()
      .pattern(/^[a-z0-9-]{1,64}$/)
      .required(),
  });

export const telegramSettingsSummarySchema =
  Joi.object<TelegramSettingsSummaryDto>({
    telegram: telegramOrderIdentitySchema,
  });

export const telegramSettingsReferenceSchema =
  Joi.object<TelegramSettingsReferenceDto>({
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
  });

export const telegramSettingsInputSchema = Joi.object<TelegramSettingsInputDto>(
  {
    telegram: telegramOrderIdentitySchema,
    ref: callbackReference.required(),
    value: Joi.string().allow('').max(64).required(),
  }
);

export const telegramUpdateIdSchema = decimalIdentifier.required();
