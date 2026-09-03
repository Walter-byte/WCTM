import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { TelegramInventoryNotificationState } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';

import { TelegramInventoryService } from '../inventory/telegram-inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramDeliveryClient } from '../telegram/telegram-delivery.client';
import {
  DEFAULT_TELEGRAM_PRESENTATION,
  TelegramPresentationService,
} from '../telegram/telegram-presentation.service';
import type { TelegramOrderNotificationRecipient } from '../telegram/telegram-order.service';
import { INVENTORY_NOTIFICATION_JOB_NAME } from './queue.constants';

export interface InventoryNotificationJobData {
  deliveryId: string;
  tenantId: string;
  storeId: string;
}

export interface InventoryNotificationJobResult {
  deliveryId: string;
  tenantId: string;
  storeId: string;
  outcome: 'delivered' | 'terminal_failure' | 'ambiguous' | 'already_final';
}

const DELIVERY_ID_PATTERN = /^tin_[A-Za-z0-9-]{1,60}$/;
const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;

export function validateInventoryNotificationJobData(
  value: unknown
): asserts value is InventoryNotificationJobData {
  if (value === null || typeof value !== 'object') {
    throw new UnrecoverableError(
      'Inventory notification job payload must be an object'
    );
  }

  const data = value as Partial<InventoryNotificationJobData>;

  if (
    typeof data.deliveryId !== 'string' ||
    !DELIVERY_ID_PATTERN.test(data.deliveryId)
  ) {
    throw new UnrecoverableError(
      'Inventory notification delivery identity is required and must be valid'
    );
  }

  if (
    typeof data.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(data.tenantId)
  ) {
    throw new UnrecoverableError(
      'Inventory notification tenant identity is required and must be valid'
    );
  }

  if (
    typeof data.storeId !== 'string' ||
    !STORE_ID_PATTERN.test(data.storeId)
  ) {
    throw new UnrecoverableError(
      'Inventory notification Store identity is required and must be valid'
    );
  }
}

@Injectable()
export class InventoryNotificationProcessor {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramInventoryService))
    private readonly inventory: TelegramInventoryService,
    private readonly deliveryClient: TelegramDeliveryClient,
    private readonly presentation?: TelegramPresentationService
  ) {}

  async process(
    job: Job<
      InventoryNotificationJobData,
      InventoryNotificationJobResult,
      typeof INVENTORY_NOTIFICATION_JOB_NAME
    >
  ): Promise<InventoryNotificationJobResult> {
    validateInventoryNotificationJobData(job.data);

    const claimedAt = new Date();
    const claimed =
      await this.prisma.telegramInventoryNotificationDelivery.updateMany({
        where: {
          id: job.data.deliveryId,
          tenantId: job.data.tenantId,
          storeId: job.data.storeId,
          state: {
            in: [
              TelegramInventoryNotificationState.PENDING,
              TelegramInventoryNotificationState.RETRYABLE_FAILURE,
            ],
          },
        },
        data: {
          state: TelegramInventoryNotificationState.IN_FLIGHT,
          attemptCount: { increment: 1 },
          lastAttemptAt: claimedAt,
          failureCategory: null,
          failureCode: null,
        },
      });

    if (claimed.count !== 1) {
      return this.resolveUnclaimed(job.data);
    }

    const delivery =
      await this.prisma.telegramInventoryNotificationDelivery.findFirst({
        where: {
          id: job.data.deliveryId,
          tenantId: job.data.tenantId,
          storeId: job.data.storeId,
          state: TelegramInventoryNotificationState.IN_FLIGHT,
        },
        select: {
          createdAt: true,
          inventoryItemId: true,
          incidentGeneration: true,
          alertLevel: true,
          policyVersion: true,
          telegramAccountId: true,
          telegramChatAuthorizationId: true,
          telegramAccount: { select: { telegramUserId: true } },
          telegramChatAuthorization: {
            select: {
              id: true,
              telegramAccountId: true,
              telegramChatId: true,
              revokedAt: true,
              updatedAt: true,
            },
          },
        },
      });

    if (
      !delivery ||
      delivery.telegramChatAuthorization.id !==
        delivery.telegramChatAuthorizationId ||
      delivery.telegramChatAuthorization.telegramAccountId !==
        delivery.telegramAccountId ||
      delivery.telegramChatAuthorization.revokedAt !== null ||
      delivery.telegramChatAuthorization.updatedAt > delivery.createdAt
    ) {
      return this.persistFailure(
        job.data,
        TelegramInventoryNotificationState.TERMINAL_FAILURE,
        'authorization',
        'recipient-context-invalid'
      );
    }

    const recipient: TelegramOrderNotificationRecipient = {
      telegramAccountId: delivery.telegramAccountId,
      telegramChatAuthorizationId: delivery.telegramChatAuthorizationId,
      telegramUserId: delivery.telegramAccount.telegramUserId.toString(),
      telegramChatId:
        delivery.telegramChatAuthorization.telegramChatId.toString(),
    };
    const prepared = await this.inventory.prepareNotification(
      recipient,
      job.data.tenantId,
      job.data.storeId,
      delivery.inventoryItemId,
      delivery.incidentGeneration,
      delivery.alertLevel,
      delivery.policyVersion
    );

    if (prepared.state !== 'OK') {
      return this.persistFailure(
        job.data,
        TelegramInventoryNotificationState.TERMINAL_FAILURE,
        prepared.state === 'UNAUTHORIZED'
          ? 'authorization'
          : prepared.state === 'DISABLED'
            ? 'policy'
            : 'inventory',
        `inventory-notification-${prepared.state.toLowerCase()}`
      );
    }

    const presentation = this.presentation
      ? await this.presentation.resolve({
          telegramUserId: recipient.telegramUserId,
          telegramChatId: recipient.telegramChatId,
        })
      : { ...DEFAULT_TELEGRAM_PRESENTATION, language: 'en' as const };
    const result = await this.deliveryClient.send({
      chatId: recipient.telegramChatId,
      presentation,
      notification: {
        type:
          prepared.classification === 'OUT_OF_STOCK'
            ? 'OUT_OF_STOCK'
            : 'LOW_STOCK',
        displayName: safePresentationValue(prepared.displayName, 255),
        sku: prepared.sku ? safePresentationValue(prepared.sku, 191) : null,
        quantity: prepared.quantity
          ? safePresentationValue(prepared.quantity, 64)
          : null,
        stockStatus: safePresentationValue(prepared.stockStatus, 32),
        threshold: prepared.threshold,
        viewStockRef: prepared.viewStockRef,
      },
    });

    if (result.outcome === 'delivered') {
      const persisted =
        await this.prisma.telegramInventoryNotificationDelivery.updateMany({
          where: {
            id: job.data.deliveryId,
            tenantId: job.data.tenantId,
            storeId: job.data.storeId,
            state: TelegramInventoryNotificationState.IN_FLIGHT,
            lastAttemptAt: claimedAt,
          },
          data: {
            state: TelegramInventoryNotificationState.DELIVERED,
            telegramMessageId: BigInt(result.messageId),
            deliveredAt: new Date(),
          },
        });

      if (persisted.count !== 1) {
        throw new Error(
          'Inventory notification delivery outcome persistence failed'
        );
      }

      return this.result(job.data, 'delivered');
    }

    if (result.outcome === 'retryable_failure') {
      await this.persistState(
        job.data,
        TelegramInventoryNotificationState.RETRYABLE_FAILURE,
        result.category,
        result.code
      );
      throw new Error('Telegram inventory notification delivery is retryable');
    }

    return this.persistFailure(
      job.data,
      result.outcome === 'terminal_failure'
        ? TelegramInventoryNotificationState.TERMINAL_FAILURE
        : TelegramInventoryNotificationState.AMBIGUOUS,
      result.category,
      result.code
    );
  }

  async markFailed(value: unknown): Promise<void> {
    validateInventoryNotificationJobData(value);

    await this.prisma.telegramInventoryNotificationDelivery.updateMany({
      where: {
        id: value.deliveryId,
        tenantId: value.tenantId,
        storeId: value.storeId,
        state: TelegramInventoryNotificationState.RETRYABLE_FAILURE,
      },
      data: {
        state: TelegramInventoryNotificationState.TERMINAL_FAILURE,
        failureCategory: 'retry-exhausted',
        failureCode: 'telegram-retry-exhausted',
      },
    });
  }

  private async resolveUnclaimed(
    data: InventoryNotificationJobData
  ): Promise<InventoryNotificationJobResult> {
    const delivery =
      await this.prisma.telegramInventoryNotificationDelivery.findFirst({
        where: {
          id: data.deliveryId,
          tenantId: data.tenantId,
          storeId: data.storeId,
        },
        select: { state: true },
      });

    if (!delivery) {
      throw new UnrecoverableError(
        'Inventory notification delivery is unavailable for processing'
      );
    }

    if (delivery.state === TelegramInventoryNotificationState.IN_FLIGHT) {
      return this.persistFailure(
        data,
        TelegramInventoryNotificationState.AMBIGUOUS,
        'dispatch',
        'in-flight-outcome-unknown'
      );
    }

    if (
      delivery.state === TelegramInventoryNotificationState.DELIVERED ||
      delivery.state === TelegramInventoryNotificationState.TERMINAL_FAILURE ||
      delivery.state === TelegramInventoryNotificationState.AMBIGUOUS
    ) {
      return this.result(data, 'already_final');
    }

    throw new Error('Inventory notification delivery could not be claimed');
  }

  private async persistFailure(
    data: InventoryNotificationJobData,
    state:
      | typeof TelegramInventoryNotificationState.TERMINAL_FAILURE
      | typeof TelegramInventoryNotificationState.AMBIGUOUS,
    category: string,
    code: string
  ): Promise<InventoryNotificationJobResult> {
    await this.persistState(data, state, category, code);

    return this.result(
      data,
      state === TelegramInventoryNotificationState.AMBIGUOUS
        ? 'ambiguous'
        : 'terminal_failure'
    );
  }

  private async persistState(
    data: InventoryNotificationJobData,
    state: TelegramInventoryNotificationState,
    category: string,
    code: string
  ): Promise<void> {
    const persisted =
      await this.prisma.telegramInventoryNotificationDelivery.updateMany({
        where: {
          id: data.deliveryId,
          tenantId: data.tenantId,
          storeId: data.storeId,
          state: TelegramInventoryNotificationState.IN_FLIGHT,
        },
        data: {
          state,
          failureCategory: category.slice(0, 32),
          failureCode: code.slice(0, 191),
        },
      });

    if (persisted.count !== 1) {
      throw new Error(
        'Inventory notification delivery outcome persistence failed'
      );
    }
  }

  private result(
    data: InventoryNotificationJobData,
    outcome: InventoryNotificationJobResult['outcome']
  ): InventoryNotificationJobResult {
    return { ...data, outcome };
  }
}

function safePresentationValue(value: string, maximumLength: number): string {
  return (
    Array.from(value.replace(/\s+/g, ' '))
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          code >= 32 &&
          code !== 127 &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069)
        );
      })
      .join('')
      .trim()
      .slice(0, maximumLength) || '—'
  );
}
