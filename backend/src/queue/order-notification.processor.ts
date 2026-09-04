import { Injectable } from '@nestjs/common';
import { TelegramOrderNotificationState } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { TelegramDeliveryClient } from '../telegram/telegram-delivery.client';
import {
  DEFAULT_TELEGRAM_PRESENTATION,
  TelegramPresentationService,
} from '../telegram/telegram-presentation.service';
import {
  type TelegramOrderNotificationRecipient,
  TelegramOrderService,
} from '../telegram/telegram-order.service';
import { ORDER_NOTIFICATION_JOB_NAME } from './queue.constants';

export interface OrderNotificationJobData {
  deliveryId: string;
  tenantId: string;
  storeId: string;
}

export interface OrderNotificationJobResult {
  deliveryId: string;
  tenantId: string;
  storeId: string;
  outcome: 'delivered' | 'terminal_failure' | 'ambiguous' | 'already_final';
}

const DELIVERY_ID_PATTERN = /^ton_[A-Za-z0-9-]{1,60}$/;
const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;

export function validateOrderNotificationJobData(
  value: unknown
): asserts value is OrderNotificationJobData {
  if (value === null || typeof value !== 'object') {
    throw new UnrecoverableError(
      'Order notification job payload must be an object'
    );
  }

  const data = value as Partial<OrderNotificationJobData>;

  if (
    typeof data.deliveryId !== 'string' ||
    !DELIVERY_ID_PATTERN.test(data.deliveryId)
  ) {
    throw new UnrecoverableError(
      'Order notification delivery identity is required and must be valid'
    );
  }

  if (
    typeof data.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(data.tenantId)
  ) {
    throw new UnrecoverableError(
      'Order notification tenant identity is required and must be valid'
    );
  }

  if (
    typeof data.storeId !== 'string' ||
    !STORE_ID_PATTERN.test(data.storeId)
  ) {
    throw new UnrecoverableError(
      'Order notification Store identity is required and must be valid'
    );
  }
}

@Injectable()
export class OrderNotificationProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramOrders: TelegramOrderService,
    private readonly deliveryClient: TelegramDeliveryClient,
    private readonly entitlements: EntitlementService,
    private readonly presentation?: TelegramPresentationService
  ) {}

  async process(
    job: Job<
      OrderNotificationJobData,
      OrderNotificationJobResult,
      typeof ORDER_NOTIFICATION_JOB_NAME
    >
  ): Promise<OrderNotificationJobResult> {
    validateOrderNotificationJobData(job.data);

    const claimedAt = new Date();
    const claimed =
      await this.prisma.telegramOrderNotificationDelivery.updateMany({
        where: {
          id: job.data.deliveryId,
          tenantId: job.data.tenantId,
          storeId: job.data.storeId,
          state: {
            in: [
              TelegramOrderNotificationState.PENDING,
              TelegramOrderNotificationState.RETRYABLE_FAILURE,
            ],
          },
        },
        data: {
          state: TelegramOrderNotificationState.IN_FLIGHT,
          attemptCount: { increment: 1 },
          lastAttemptAt: claimedAt,
          failureCategory: null,
          failureCode: null,
        },
      });

    if (claimed.count !== 1) {
      return this.resolveUnclaimed(job.data);
    }

    if (!(await this.currentlyActive(job.data.tenantId))) {
      return this.persistFailure(
        job.data,
        TelegramOrderNotificationState.TERMINAL_FAILURE,
        'policy',
        'entitlement-inactive'
      );
    }

    const delivery =
      await this.prisma.telegramOrderNotificationDelivery.findFirst({
        where: {
          id: job.data.deliveryId,
          tenantId: job.data.tenantId,
          storeId: job.data.storeId,
          state: TelegramOrderNotificationState.IN_FLIGHT,
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          telegramAccountId: true,
          telegramChatAuthorizationId: true,
          order: { select: { wcOrderId: true } },
          telegramAccount: { select: { telegramUserId: true } },
          telegramChatAuthorization: {
            select: {
              id: true,
              telegramAccountId: true,
              telegramChatId: true,
            },
          },
        },
      });

    if (
      !delivery ||
      delivery.telegramChatAuthorization.id !==
        delivery.telegramChatAuthorizationId ||
      delivery.telegramChatAuthorization.telegramAccountId !==
        delivery.telegramAccountId
    ) {
      return this.persistFailure(
        job.data,
        TelegramOrderNotificationState.TERMINAL_FAILURE,
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
    const prepared = await this.telegramOrders.prepareOrderNotification(
      recipient,
      delivery.tenantId,
      delivery.storeId,
      delivery.order.wcOrderId
    );

    if (prepared.state !== 'OK') {
      return this.persistFailure(
        job.data,
        TelegramOrderNotificationState.TERMINAL_FAILURE,
        prepared.state === 'UNAUTHORIZED'
          ? 'authorization'
          : prepared.state === 'DISABLED'
            ? 'policy'
            : 'order',
        `notification-${prepared.state.toLowerCase()}`
      );
    }

    const presentation = this.presentation
      ? await this.presentation.resolve({
          telegramUserId: recipient.telegramUserId,
          telegramChatId: recipient.telegramChatId,
        })
      : { ...DEFAULT_TELEGRAM_PRESENTATION, language: 'en' as const };
    if (!(await this.currentlyActive(job.data.tenantId))) {
      return this.persistFailure(
        job.data,
        TelegramOrderNotificationState.TERMINAL_FAILURE,
        'policy',
        'entitlement-inactive'
      );
    }
    const result = await this.deliveryClient.send({
      chatId: recipient.telegramChatId,
      presentation,
      notification: {
        type: 'ORDER_CREATED',
        orderNumber: safePresentationValue(prepared.orderNumber, 191),
        status: safePresentationValue(prepared.status, 64),
        currency: safePresentationValue(prepared.currency, 16),
        total: safePresentationValue(prepared.total, 64),
        customerDisplayName: safePresentationValue(
          prepared.customerDisplayName,
          255
        ),
        viewOrderRef: prepared.viewOrderRef,
        changeStatusAvailable: prepared.changeStatusAvailable,
      },
    });

    if (result.outcome === 'delivered') {
      const persisted =
        await this.prisma.telegramOrderNotificationDelivery.updateMany({
          where: {
            id: job.data.deliveryId,
            tenantId: job.data.tenantId,
            storeId: job.data.storeId,
            state: TelegramOrderNotificationState.IN_FLIGHT,
            lastAttemptAt: claimedAt,
          },
          data: {
            state: TelegramOrderNotificationState.DELIVERED,
            telegramMessageId: BigInt(result.messageId),
            deliveredAt: new Date(),
          },
        });

      if (persisted.count !== 1) {
        throw new Error('Notification delivery outcome persistence failed');
      }

      return this.result(job.data, 'delivered');
    }

    if (result.outcome === 'retryable_failure') {
      await this.persistState(
        job.data,
        TelegramOrderNotificationState.RETRYABLE_FAILURE,
        result.category,
        result.code
      );
      throw new Error('Telegram notification delivery is retryable');
    }

    return this.persistFailure(
      job.data,
      result.outcome === 'terminal_failure'
        ? TelegramOrderNotificationState.TERMINAL_FAILURE
        : TelegramOrderNotificationState.AMBIGUOUS,
      result.category,
      result.code
    );
  }

  private async currentlyActive(tenantId: string): Promise<boolean> {
    return this.entitlements.isActive(tenantId);
  }

  async markFailed(value: unknown): Promise<void> {
    validateOrderNotificationJobData(value);

    await this.prisma.telegramOrderNotificationDelivery.updateMany({
      where: {
        id: value.deliveryId,
        tenantId: value.tenantId,
        storeId: value.storeId,
        state: TelegramOrderNotificationState.RETRYABLE_FAILURE,
      },
      data: {
        state: TelegramOrderNotificationState.TERMINAL_FAILURE,
        failureCategory: 'retry-exhausted',
        failureCode: 'telegram-retry-exhausted',
      },
    });
  }

  private async resolveUnclaimed(
    data: OrderNotificationJobData
  ): Promise<OrderNotificationJobResult> {
    const delivery =
      await this.prisma.telegramOrderNotificationDelivery.findFirst({
        where: {
          id: data.deliveryId,
          tenantId: data.tenantId,
          storeId: data.storeId,
        },
        select: { state: true },
      });

    if (!delivery) {
      throw new UnrecoverableError(
        'Order notification delivery is unavailable for processing'
      );
    }

    if (delivery.state === TelegramOrderNotificationState.IN_FLIGHT) {
      return this.persistFailure(
        data,
        TelegramOrderNotificationState.AMBIGUOUS,
        'dispatch',
        'in-flight-outcome-unknown'
      );
    }

    if (
      delivery.state === TelegramOrderNotificationState.DELIVERED ||
      delivery.state === TelegramOrderNotificationState.TERMINAL_FAILURE ||
      delivery.state === TelegramOrderNotificationState.AMBIGUOUS
    ) {
      return this.result(data, 'already_final');
    }

    throw new Error('Order notification delivery could not be claimed');
  }

  private async persistFailure(
    data: OrderNotificationJobData,
    state:
      | typeof TelegramOrderNotificationState.TERMINAL_FAILURE
      | typeof TelegramOrderNotificationState.AMBIGUOUS,
    category: string,
    code: string
  ): Promise<OrderNotificationJobResult> {
    await this.persistState(data, state, category, code);

    return this.result(
      data,
      state === TelegramOrderNotificationState.AMBIGUOUS
        ? 'ambiguous'
        : 'terminal_failure'
    );
  }

  private async persistState(
    data: OrderNotificationJobData,
    state: TelegramOrderNotificationState,
    category: string,
    code: string
  ): Promise<void> {
    const persisted =
      await this.prisma.telegramOrderNotificationDelivery.updateMany({
        where: {
          id: data.deliveryId,
          tenantId: data.tenantId,
          storeId: data.storeId,
          state: TelegramOrderNotificationState.IN_FLIGHT,
        },
        data: {
          state,
          failureCategory: category.slice(0, 32),
          failureCode: code.slice(0, 191),
        },
      });

    if (persisted.count !== 1) {
      throw new Error('Notification delivery outcome persistence failed');
    }
  }

  private result(
    data: OrderNotificationJobData,
    outcome: OrderNotificationJobResult['outcome']
  ): OrderNotificationJobResult {
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
