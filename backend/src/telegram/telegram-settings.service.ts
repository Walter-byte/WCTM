import { Injectable, Optional } from '@nestjs/common';
import {
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
  Prisma,
  StoreStatus,
  TelegramSettingsAction,
  TelegramSettingsReferencePurpose,
  TenantLanguage,
} from '@prisma/client';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryBootstrapScheduler } from '../queue/inventory-bootstrap.scheduler';
import {
  type TelegramOrderIdentityDto,
  type TelegramSettingsInputDto,
  type TelegramSettingsReferenceDto,
  type TelegramSettingsSummaryDto,
} from './dto/telegram-internal.dto';
import { TelegramOrderService } from './telegram-order.service';

const SETTINGS_REFERENCE_ID_BYTES = 12;
const SETTINGS_REFERENCE_SIGNATURE_BYTES = 12;
const LOW_STOCK_THRESHOLD_MAX = 1_000_000;
const MUTATION_ATTEMPTS = 3;
const ALLOWED_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

interface SettingsContext {
  accountId: string;
  userId: string;
  membershipId: string;
  telegramChatId: bigint;
  tenantId: string;
  storeId: string;
  role: MembershipRole;
}

type SettingsContextResolution =
  | { state: 'OK'; context: SettingsContext }
  | { state: 'NO_ACTIVE_STORE' | 'UNAUTHORIZED' };

export type TelegramSettingsState =
  | 'OK'
  | 'NO_ACTIVE_STORE'
  | 'UNAUTHORIZED'
  | 'CONTEXT_CHANGED'
  | 'FORBIDDEN_ROLE'
  | 'INVALID_VALUE'
  | 'EXPIRED_REF';

export interface TelegramSettingsRecipient {
  displayName: string;
  selected: boolean;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  actionRef?: string;
  action?: 'SELECT' | 'REMOVE';
}

export interface TelegramSettingsSummary {
  language: TenantLanguage;
  timezone: string;
  lowStockThreshold: number | null;
  enabledNotificationCategories: NotificationCategory[];
  recipientMode: NotificationRecipientMode;
  selectedRecipientCount: number;
  availableRecipientCount: number;
  editable: boolean;
  recipients: TelegramSettingsRecipient[];
  actions?: {
    languages: Array<{ language: TenantLanguage; ref: string }>;
    timezoneInputRef: string;
    thresholdInputRef: string;
    thresholdClearRef: string;
    categories: Array<{
      category: NotificationCategory;
      enabled: boolean;
      enableRef: string;
      disableRef: string;
    }>;
    recipientModes: Array<{
      mode: NotificationRecipientMode;
      ref: string;
    }>;
  };
}

export interface TelegramSettingsResult {
  state: TelegramSettingsState;
  settings?: TelegramSettingsSummary;
}

export interface TelegramSettingsInputStartResult {
  state: TelegramSettingsState;
  purpose?: 'TIMEZONE' | 'THRESHOLD';
  inputRef?: string;
}

const SETTINGS_REFERENCE_SELECT = {
  id: true,
  telegramAccountId: true,
  telegramChatId: true,
  tenantId: true,
  storeId: true,
  purpose: true,
  action: true,
  language: true,
  notificationCategory: true,
  desiredEnabled: true,
  recipientMode: true,
  targetMembershipId: true,
  expiresAt: true,
  consumedAt: true,
} satisfies Prisma.TelegramSettingsReferenceSelect;

type SettingsReference = Prisma.TelegramSettingsReferenceGetPayload<{
  select: typeof SETTINGS_REFERENCE_SELECT;
}>;

type Transaction = Prisma.TransactionClient;

@Injectable()
export class TelegramSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly telegramOrders: TelegramOrderService,
    @Optional()
    private readonly inventoryBootstrap?: InventoryBootstrapScheduler
  ) {}

  async summary(
    input: TelegramSettingsSummaryDto
  ): Promise<TelegramSettingsResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    await this.ensureInventoryIfRelevant(resolved.context);
    return this.ok(resolved.context);
  }

  async startInput(
    input: TelegramSettingsReferenceDto
  ): Promise<TelegramSettingsInputStartResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    if (resolved.context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    const reference = await this.validateReference(input.ref, resolved.context);

    if (!reference) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (reference.consumedAt) {
      return { state: 'EXPIRED_REF' };
    }

    if (
      reference.purpose !== TelegramSettingsReferencePurpose.TIMEZONE_INPUT &&
      reference.purpose !== TelegramSettingsReferencePurpose.THRESHOLD_INPUT
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    return {
      state: 'OK',
      purpose:
        reference.purpose === TelegramSettingsReferencePurpose.TIMEZONE_INPUT
          ? 'TIMEZONE'
          : 'THRESHOLD',
      inputRef: input.ref,
    };
  }

  async applyInput(
    input: TelegramSettingsInputDto
  ): Promise<TelegramSettingsResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    const reference = await this.validateReference(input.ref, context);

    if (!reference) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (reference.consumedAt) {
      return { state: 'EXPIRED_REF' };
    }

    if (reference.purpose === TelegramSettingsReferencePurpose.TIMEZONE_INPUT) {
      const timezone = canonicalTimezone(input.value);

      if (!timezone) {
        return { state: 'INVALID_VALUE' };
      }

      const changed = await this.withMutation(async (transaction) => {
        if (!(await this.consumeReference(transaction, reference, context))) {
          return undefined;
        }

        const tenant = await transaction.tenant.findFirst({
          where: { id: context.tenantId, deletedAt: null },
          select: { timezone: true },
        });

        if (!tenant || tenant.timezone === timezone) {
          return false;
        }

        await transaction.tenant.update({
          where: { id: context.tenantId },
          data: { timezone },
          select: { id: true },
        });
        await this.audit(transaction, context, 'Tenant', context.tenantId, {
          settingType: 'timezone',
          previousValue: tenant.timezone,
          newValue: timezone,
          result: 'changed',
        });
        return true;
      });

      return changed === undefined
        ? { state: 'EXPIRED_REF' }
        : this.ok(context);
    }

    if (
      reference.purpose === TelegramSettingsReferencePurpose.THRESHOLD_INPUT
    ) {
      const threshold = parseThreshold(input.value);

      if (threshold === undefined) {
        return { state: 'INVALID_VALUE' };
      }

      const changed = await this.withMutation(async (transaction) => {
        if (!(await this.consumeReference(transaction, reference, context))) {
          return undefined;
        }

        const store = await this.loadStore(transaction, context);

        if (!store || store.lowStockThreshold === threshold) {
          return false;
        }

        await transaction.store.update({
          where: { id: context.storeId },
          data: { lowStockThreshold: threshold },
          select: { id: true },
        });
        await this.rebaselineInventory(transaction, context, threshold);
        await this.audit(transaction, context, 'Store', context.storeId, {
          settingType: 'low_stock_threshold',
          previousValue: store.lowStockThreshold,
          newValue: threshold,
          result: 'changed',
        });
        return true;
      });

      if (changed === undefined) {
        return { state: 'EXPIRED_REF' };
      }

      await this.ensureInventoryIfRelevant(context);
      return this.ok(context);
    }

    return { state: 'CONTEXT_CHANGED' };
  }

  async applyAction(
    input: TelegramSettingsReferenceDto
  ): Promise<TelegramSettingsResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    const reference = await this.validateReference(input.ref, context);

    if (
      !reference ||
      reference.purpose !== TelegramSettingsReferencePurpose.ACTION ||
      !reference.action
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const applied = await this.applyDesiredAction(context, reference);

    if (!applied) {
      return { state: 'CONTEXT_CHANGED' };
    }

    await this.ensureInventoryIfRelevant(context);
    return this.ok(context);
  }

  private async applyDesiredAction(
    context: SettingsContext,
    reference: SettingsReference
  ): Promise<boolean> {
    return this.withMutation(async (transaction) => {
      const store = await this.loadStore(transaction, context);

      if (!store) {
        return false;
      }

      if (
        reference.action === TelegramSettingsAction.SET_LANGUAGE &&
        reference.language
      ) {
        const tenant = await transaction.tenant.findFirst({
          where: { id: context.tenantId, deletedAt: null },
          select: { language: true },
        });

        if (!tenant) {
          return false;
        }

        if (tenant.language === reference.language) {
          return true;
        }

        await transaction.tenant.update({
          where: { id: context.tenantId },
          data: { language: reference.language },
          select: { id: true },
        });
        await this.audit(transaction, context, 'Tenant', context.tenantId, {
          settingType: 'language',
          previousValue: tenant.language,
          newValue: reference.language,
          result: 'changed',
        });
        return true;
      }

      if (
        reference.action === TelegramSettingsAction.SET_CATEGORY &&
        reference.notificationCategory &&
        reference.desiredEnabled !== null
      ) {
        const categories = new Set(store.enabledNotificationCategories);
        const wasEnabled = categories.has(reference.notificationCategory);

        if (wasEnabled === reference.desiredEnabled) {
          return true;
        }

        if (reference.desiredEnabled) {
          categories.add(reference.notificationCategory);
        } else {
          categories.delete(reference.notificationCategory);
        }

        const next = [...categories].sort();
        await transaction.store.update({
          where: { id: context.storeId },
          data: {
            enabledNotificationCategories: next,
            ...(reference.notificationCategory ===
            NotificationCategory.LOW_STOCK
              ? { inventoryNotificationPolicyVersion: { increment: 1 } }
              : {}),
          },
          select: { id: true },
        });
        await this.audit(transaction, context, 'Store', context.storeId, {
          settingType: 'notification_category',
          category: reference.notificationCategory,
          previousValue: wasEnabled ? 'enabled' : 'disabled',
          newValue: reference.desiredEnabled ? 'enabled' : 'disabled',
          result: 'changed',
        });
        return true;
      }

      if (
        reference.action === TelegramSettingsAction.SET_RECIPIENT_MODE &&
        reference.recipientMode
      ) {
        if (store.notificationRecipientMode === reference.recipientMode) {
          return true;
        }

        await transaction.store.update({
          where: { id: context.storeId },
          data: {
            notificationRecipientMode: reference.recipientMode,
            inventoryNotificationPolicyVersion: { increment: 1 },
          },
          select: { id: true },
        });
        await this.audit(transaction, context, 'Store', context.storeId, {
          settingType: 'notification_recipient_mode',
          previousValue: store.notificationRecipientMode,
          newValue: reference.recipientMode,
          result: 'changed',
        });
        return true;
      }

      if (reference.action === TelegramSettingsAction.CLEAR_THRESHOLD) {
        if (store.lowStockThreshold === null) {
          return true;
        }

        await transaction.store.update({
          where: { id: context.storeId },
          data: { lowStockThreshold: null },
          select: { id: true },
        });
        await this.rebaselineInventory(transaction, context, null);
        await this.audit(transaction, context, 'Store', context.storeId, {
          settingType: 'low_stock_threshold',
          previousValue: store.lowStockThreshold,
          newValue: 'not_configured',
          result: 'changed',
        });
        return true;
      }

      if (
        reference.action === TelegramSettingsAction.SET_RECIPIENT_SELECTION &&
        reference.targetMembershipId &&
        reference.desiredEnabled !== null
      ) {
        const existing =
          await transaction.storeNotificationRecipient.findUnique({
            where: {
              storeId_membershipId: {
                storeId: context.storeId,
                membershipId: reference.targetMembershipId,
              },
            },
            select: { id: true },
          });

        if (reference.desiredEnabled) {
          const membership = await transaction.membership.findFirst({
            where: {
              id: reference.targetMembershipId,
              tenantId: context.tenantId,
              deletedAt: null,
              tenant: { deletedAt: null },
              role: { in: [...ALLOWED_ROLES] },
            },
            select: { id: true },
          });

          if (!membership) {
            return false;
          }

          if (existing) {
            return true;
          }

          await transaction.storeNotificationRecipient.create({
            data: {
              id: `snr_${randomUUID()}`,
              tenantId: context.tenantId,
              storeId: context.storeId,
              membershipId: membership.id,
            },
            select: { id: true },
          });
        } else {
          if (!existing) {
            return true;
          }

          await transaction.storeNotificationRecipient.delete({
            where: { id: existing.id },
            select: { id: true },
          });
        }

        await transaction.store.update({
          where: { id: context.storeId },
          data: { inventoryNotificationPolicyVersion: { increment: 1 } },
          select: { id: true },
        });

        const recipientCount =
          await transaction.storeNotificationRecipient.count({
            where: { tenantId: context.tenantId, storeId: context.storeId },
          });
        await this.audit(transaction, context, 'Store', context.storeId, {
          settingType: 'manager_recipient',
          recipientAction: reference.desiredEnabled ? 'selected' : 'removed',
          recipientCount,
          result: 'changed',
        });
        return true;
      }

      return false;
    });
  }

  private async ok(context: SettingsContext): Promise<TelegramSettingsResult> {
    const settings = await this.buildSummary(context);

    return settings ? { state: 'OK', settings } : { state: 'CONTEXT_CHANGED' };
  }

  private async buildSummary(
    context: SettingsContext
  ): Promise<TelegramSettingsSummary | undefined> {
    const store = await this.prisma.store.findFirst({
      where: {
        id: context.storeId,
        tenantId: context.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        lowStockThreshold: true,
        enabledNotificationCategories: true,
        notificationRecipientMode: true,
        tenant: { select: { timezone: true, language: true } },
        selectedNotificationRecipients: {
          select: {
            membershipId: true,
            membership: {
              select: {
                id: true,
                deletedAt: true,
                role: true,
                user: { select: { displayName: true } },
              },
            },
          },
        },
      },
    });

    if (!store) {
      return undefined;
    }

    const activeMemberships = await this.prisma.membership.findMany({
      where: {
        tenantId: context.tenantId,
        deletedAt: null,
        tenant: { deletedAt: null },
        role: { in: [...ALLOWED_ROLES] },
      },
      select: {
        id: true,
        deletedAt: true,
        role: true,
        user: { select: { displayName: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const selectedById = new Map(
      store.selectedNotificationRecipients.map((item) => [
        item.membershipId,
        item.membership,
      ])
    );
    const memberships = new Map(
      activeMemberships.map((membership) => [membership.id, membership])
    );

    for (const [membershipId, membership] of selectedById) {
      memberships.set(membershipId, membership);
    }

    const eligible = new Set(
      (
        await this.telegramOrders.eligibleNotificationRecipients(
          context.tenantId,
          context.storeId
        )
      ).map((recipient) => recipient.membershipId)
    );
    const editable = context.role !== MembershipRole.MEMBER;
    const expiresAt = this.referenceExpiry();
    const references: Prisma.TelegramSettingsReferenceCreateManyInput[] = [];
    const recipientRows: TelegramSettingsRecipient[] = [];

    for (const membership of memberships.values()) {
      const selected = selectedById.has(membership.id);
      let actionRef: string | undefined;

      if (editable && (selected || membership.deletedAt === null)) {
        const reference = this.newReference(
          context,
          {
            purpose: TelegramSettingsReferencePurpose.ACTION,
            action: TelegramSettingsAction.SET_RECIPIENT_SELECTION,
            desiredEnabled: !selected,
            targetMembershipId: membership.id,
          },
          expiresAt
        );
        references.push(reference.data);
        actionRef = reference.token;
      }

      recipientRows.push({
        displayName: safeManagerDisplayName(membership.user.displayName),
        selected,
        availability: eligible.has(membership.id) ? 'AVAILABLE' : 'UNAVAILABLE',
        ...(actionRef
          ? {
              actionRef,
              action: selected ? ('REMOVE' as const) : ('SELECT' as const),
            }
          : {}),
      });
    }

    const summary: TelegramSettingsSummary = {
      language: store.tenant.language,
      timezone: store.tenant.timezone,
      lowStockThreshold: store.lowStockThreshold,
      enabledNotificationCategories: store.enabledNotificationCategories,
      recipientMode: store.notificationRecipientMode,
      selectedRecipientCount: selectedById.size,
      availableRecipientCount: eligible.size,
      editable,
      recipients: recipientRows,
    };

    if (editable) {
      const languageRefs = [TenantLanguage.FA, TenantLanguage.EN].map(
        (language) =>
          this.newReference(
            context,
            {
              purpose: TelegramSettingsReferencePurpose.ACTION,
              action: TelegramSettingsAction.SET_LANGUAGE,
              language,
            },
            expiresAt
          )
      );
      const timezoneRef = this.newReference(
        context,
        { purpose: TelegramSettingsReferencePurpose.TIMEZONE_INPUT },
        expiresAt
      );
      const thresholdRef = this.newReference(
        context,
        { purpose: TelegramSettingsReferencePurpose.THRESHOLD_INPUT },
        expiresAt
      );
      const clearThresholdRef = this.newReference(
        context,
        {
          purpose: TelegramSettingsReferencePurpose.ACTION,
          action: TelegramSettingsAction.CLEAR_THRESHOLD,
        },
        expiresAt
      );
      const categories = [
        NotificationCategory.ORDER_CREATED,
        NotificationCategory.LOW_STOCK,
      ].map((category) => {
        const enabled = store.enabledNotificationCategories.includes(category);
        const enable = this.newReference(
          context,
          {
            purpose: TelegramSettingsReferencePurpose.ACTION,
            action: TelegramSettingsAction.SET_CATEGORY,
            notificationCategory: category,
            desiredEnabled: true,
          },
          expiresAt
        );
        const disable = this.newReference(
          context,
          {
            purpose: TelegramSettingsReferencePurpose.ACTION,
            action: TelegramSettingsAction.SET_CATEGORY,
            notificationCategory: category,
            desiredEnabled: false,
          },
          expiresAt
        );
        references.push(enable.data, disable.data);
        return {
          category,
          enabled,
          enableRef: enable.token,
          disableRef: disable.token,
        };
      });
      const recipientModes = [
        NotificationRecipientMode.ALL_ELIGIBLE,
        NotificationRecipientMode.SELECTED,
      ].map((mode) => {
        const reference = this.newReference(
          context,
          {
            purpose: TelegramSettingsReferencePurpose.ACTION,
            action: TelegramSettingsAction.SET_RECIPIENT_MODE,
            recipientMode: mode,
          },
          expiresAt
        );
        references.push(reference.data);
        return { mode, ref: reference.token };
      });

      references.push(
        ...languageRefs.map((reference) => reference.data),
        timezoneRef.data,
        thresholdRef.data,
        clearThresholdRef.data
      );
      summary.actions = {
        languages: languageRefs.map((reference, index) => ({
          language: index === 0 ? TenantLanguage.FA : TenantLanguage.EN,
          ref: reference.token,
        })),
        timezoneInputRef: timezoneRef.token,
        thresholdInputRef: thresholdRef.token,
        thresholdClearRef: clearThresholdRef.token,
        categories,
        recipientModes,
      };
    }

    if (references.length > 0) {
      await this.prisma.telegramSettingsReference.createMany({
        data: references,
      });
    }

    return summary;
  }

  private async resolveContext(
    identity: TelegramOrderIdentityDto
  ): Promise<SettingsContextResolution> {
    const telegramUserId = BigInt(identity.userId);
    const telegramChatId = BigInt(identity.chatId);
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        chatAuthorizations: {
          where: { telegramChatId, revokedAt: null },
          select: { telegramAccountId: true },
        },
      },
    });

    if (
      !account ||
      account.deletedAt ||
      account.chatAuthorizations.length !== 1 ||
      account.chatAuthorizations[0]?.telegramAccountId !== account.id
    ) {
      return { state: 'UNAUTHORIZED' };
    }

    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: account.userId,
        deletedAt: null,
        tenant: { deletedAt: null },
        role: { in: [...ALLOWED_ROLES] },
      },
      select: { id: true, tenantId: true, role: true },
      take: 2,
    });

    if (memberships.length === 0) {
      return { state: 'UNAUTHORIZED' };
    }

    if (memberships.length !== 1) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    const membership = memberships[0]!;
    const stores = await this.prisma.store.findMany({
      where: {
        tenantId: membership.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { id: true },
      take: 2,
    });

    if (stores.length !== 1) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    return {
      state: 'OK',
      context: {
        accountId: account.id,
        userId: account.userId,
        membershipId: membership.id,
        telegramChatId,
        tenantId: membership.tenantId,
        storeId: stores[0]!.id,
        role: membership.role,
      },
    };
  }

  private loadStore(transaction: Transaction, context: SettingsContext) {
    return transaction.store.findFirst({
      where: {
        id: context.storeId,
        tenantId: context.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        lowStockThreshold: true,
        enabledNotificationCategories: true,
        notificationRecipientMode: true,
      },
    });
  }

  private async validateReference(
    token: string,
    context: SettingsContext
  ): Promise<SettingsReference | undefined> {
    const parsed = this.parseToken(token);

    if (!parsed) {
      return undefined;
    }

    const reference = await this.prisma.telegramSettingsReference.findUnique({
      where: { id: parsed.referenceId },
      select: SETTINGS_REFERENCE_SELECT,
    });

    if (
      !reference ||
      reference.expiresAt <= new Date() ||
      reference.telegramAccountId !== context.accountId ||
      reference.telegramChatId !== context.telegramChatId ||
      reference.tenantId !== context.tenantId ||
      reference.storeId !== context.storeId
    ) {
      return undefined;
    }

    return reference;
  }

  private async consumeReference(
    transaction: Transaction,
    reference: SettingsReference,
    context: SettingsContext
  ): Promise<boolean> {
    const consumed = await transaction.telegramSettingsReference.updateMany({
      where: {
        id: reference.id,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });

    return consumed.count === 1;
  }

  private newReference(
    context: SettingsContext,
    values: Pick<
      Prisma.TelegramSettingsReferenceCreateManyInput,
      | 'purpose'
      | 'action'
      | 'language'
      | 'notificationCategory'
      | 'desiredEnabled'
      | 'recipientMode'
      | 'targetMembershipId'
    >,
    expiresAt: Date
  ): { token: string; data: Prisma.TelegramSettingsReferenceCreateManyInput } {
    const shortId = randomBytes(SETTINGS_REFERENCE_ID_BYTES).toString(
      'base64url'
    );
    const id = `tsr_${shortId}`;

    return {
      token: this.tokenForReferenceId(id),
      data: {
        id,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        expiresAt,
        ...values,
      },
    };
  }

  private tokenForReferenceId(referenceId: string): string {
    const shortId = referenceId.replace(/^tsr_/, '');
    const signedValue = `g.${shortId}`;
    const signature = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signedValue)
      .digest()
      .subarray(0, SETTINGS_REFERENCE_SIGNATURE_BYTES)
      .toString('base64url');

    return `${signedValue}.${signature}`;
  }

  private parseToken(token: string): { referenceId: string } | undefined {
    const parts = token.split('.');

    if (
      parts.length !== 3 ||
      parts[0] !== 'g' ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[2] ?? '')
    ) {
      return undefined;
    }

    const signedValue = `g.${parts[1]}`;
    const supplied = Buffer.from(parts[2]!, 'base64url');
    const expected = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signedValue)
      .digest()
      .subarray(0, SETTINGS_REFERENCE_SIGNATURE_BYTES);

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return undefined;
    }

    return { referenceId: `tsr_${parts[1]}` };
  }

  private referenceExpiry(): Date {
    return new Date(
      Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
    );
  }

  private async audit(
    transaction: Transaction,
    context: SettingsContext,
    entityType: 'Tenant' | 'Store',
    entityId: string,
    metadata: Prisma.InputJsonObject
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        id: `aud_${randomUUID()}`,
        tenantId: context.tenantId,
        userId: context.userId,
        action: 'telegram.settings.updated',
        entityType,
        entityId,
        metadata,
      },
      select: { id: true },
    });
  }

  private async ensureInventoryIfRelevant(
    context: SettingsContext
  ): Promise<void> {
    if (!this.inventoryBootstrap) {
      return;
    }

    const store = await this.prisma.store.findFirst({
      where: {
        id: context.storeId,
        tenantId: context.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
      },
      select: { enabledNotificationCategories: true },
    });

    if (
      store?.enabledNotificationCategories.includes(
        NotificationCategory.LOW_STOCK
      )
    ) {
      await this.inventoryBootstrap.ensureInitialized(
        context.tenantId,
        context.storeId
      );
    }
  }

  private async rebaselineInventory(
    transaction: Transaction,
    context: SettingsContext,
    threshold: number | null
  ): Promise<void> {
    const quantitativeClassification =
      threshold === null
        ? Prisma.sql`FALSE`
        : Prisma.sql`"manages_stock" AND "stock_quantity" <= ${threshold}`;

    await transaction.$executeRaw(Prisma.sql`
      WITH classified AS (
        SELECT
          "id",
          CASE
            WHEN "stock_status" = 'outofstock'
              THEN 'OUT_OF_STOCK'::"inventory_alert_classification"
            WHEN ${quantitativeClassification}
              THEN 'LOW_STOCK'::"inventory_alert_classification"
            ELSE 'HEALTHY'::"inventory_alert_classification"
          END AS next_classification
        FROM "inventory_items"
        WHERE "tenant_id" = ${context.tenantId}
          AND "store_id" = ${context.storeId}
          AND "remote_deleted_at" IS NULL
      )
      UPDATE "inventory_items" AS item
      SET
        "alert_classification" = classified.next_classification,
        "incident_generation" = CASE
          WHEN item."alert_classification" = 'HEALTHY'
            AND classified.next_classification <> 'HEALTHY'
            THEN item."incident_generation" + 1
          ELSE item."incident_generation"
        END,
        "low_alert_source_webhook_event_id" = NULL,
        "low_alert_recipients_captured_at" = NULL,
        "out_alert_source_webhook_event_id" = NULL,
        "out_alert_recipients_captured_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      FROM classified
      WHERE item."id" = classified."id"
        AND item."alert_classification" IS DISTINCT FROM classified.next_classification
    `);
  }

  private async withMutation<T>(
    operation: (transaction: Transaction) => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; attempt <= MUTATION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (attempt === MUTATION_ATTEMPTS || !isRetryableTransaction(error)) {
          throw error;
        }
      }
    }

    throw new Error('Settings mutation transaction failed');
  }
}

export function canonicalTimezone(value: string): string | undefined {
  const timezone = value.trim();

  if (
    timezone.length === 0 ||
    timezone.length > 64 ||
    (timezone !== 'UTC' && !timezone.includes('/'))
  ) {
    return undefined;
  }

  try {
    const canonical = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
    }).resolvedOptions().timeZone;

    return canonical === 'UTC' || canonical.includes('/')
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function parseThreshold(value: string): number | undefined {
  const threshold = value.trim();

  if (!/^\d{1,7}$/.test(threshold)) {
    return undefined;
  }

  const parsed = Number(threshold);

  return Number.isSafeInteger(parsed) && parsed <= LOW_STOCK_THRESHOLD_MAX
    ? parsed
    : undefined;
}

function safeManagerDisplayName(value: string | null): string {
  if (!value) {
    return 'Manager';
  }

  const safe = Array.from(value.trim())
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 80);

  return safe || 'Manager';
}

function isRetryableTransaction(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
  );
}
