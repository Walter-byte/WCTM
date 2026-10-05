import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { WebhookEventStatus } from '@prisma/client';

import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 24 * 60 * 60 * 1_000;
export const TRANSIENT_TOKEN_RETENTION_DAYS = 1;
export const COMPLETED_WEBHOOK_PAYLOAD_RETENTION_DAYS = 30;
export const FAILED_WEBHOOK_PAYLOAD_RETENTION_DAYS = 90;
export const SECURITY_AUDIT_RETENTION_DAYS = 365;
const RETENTION_INTERVAL_MS = DAY;

@Injectable()
export class PilotRetentionService
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly logger: StructuredLoggerService
  ) {}

  onModuleInit(): void {
    if (this.configuration.app.nodeEnv === 'test') return;
    this.initialTimer = setTimeout(() => this.runSweep(), 60_000);
    this.initialTimer.unref();
    this.timer = setInterval(() => this.runSweep(), RETENTION_INTERVAL_MS);
    this.timer.unref();
  }

  private runSweep(): void {
    void this.sweep().catch(() => {
      this.logger.error(
        'Pilot PostgreSQL retention sweep failed',
        { policy: 'ppr2' },
        PilotRetentionService.name
      );
    });
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const transientCutoff = new Date(
        now.getTime() - TRANSIENT_TOKEN_RETENTION_DAYS * DAY
      );
      await this.database.telegramLinkToken.deleteMany({
        where: { expiresAt: { lt: transientCutoff } },
      });
      await this.database.store.updateMany({
        where: { registrationTokenExpiresAt: { lt: transientCutoff } },
        data: {
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
        },
      });
      await this.database.telegramCallbackReference.updateMany({
        where: {
          expiresAt: { lt: transientCutoff },
          noteBodyEncrypted: { not: null },
        },
        data: { noteBodyEncrypted: null, noteContentFingerprint: null },
      });
      await this.database.telegramSearchReference.updateMany({
        where: {
          expiresAt: { lt: transientCutoff },
          queryEncrypted: { not: null },
        },
        data: { queryEncrypted: null },
      });
      await this.database.webhookEvent.updateMany({
        where: {
          status: WebhookEventStatus.COMPLETED,
          completedAt: {
            lt: new Date(
              now.getTime() - COMPLETED_WEBHOOK_PAYLOAD_RETENTION_DAYS * DAY
            ),
          },
        },
        data: { payload: {} },
      });
      await this.database.webhookEvent.updateMany({
        where: {
          status: WebhookEventStatus.FAILED,
          failedAt: {
            lt: new Date(
              now.getTime() - FAILED_WEBHOOK_PAYLOAD_RETENTION_DAYS * DAY
            ),
          },
        },
        data: { payload: {} },
      });
      await this.database.auditLog.deleteMany({
        where: {
          createdAt: {
            lt: new Date(now.getTime() - SECURITY_AUDIT_RETENTION_DAYS * DAY),
          },
        },
      });
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
