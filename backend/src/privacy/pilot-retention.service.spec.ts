import { describe, expect, it, jest } from '@jest/globals';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  COMPLETED_WEBHOOK_PAYLOAD_RETENTION_DAYS,
  FAILED_WEBHOOK_PAYLOAD_RETENTION_DAYS,
  PilotRetentionService,
  SECURITY_AUDIT_RETENTION_DAYS,
} from './pilot-retention.service';

describe('pilot PostgreSQL retention', () => {
  it('uses fixed cutoffs and leaves queued or active webhook payloads untouched', async () => {
    const deleteMany = jest.fn(async () => ({ count: 0 }));
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const webhookUpdate = jest.fn(async () => ({ count: 0 }));
    const database = {
      telegramLinkToken: { deleteMany },
      store: { updateMany },
      telegramCallbackReference: { updateMany },
      telegramSearchReference: { updateMany },
      webhookEvent: { updateMany: webhookUpdate },
      auditLog: { deleteMany },
    } as unknown as PrismaService;
    const service = new PilotRetentionService(
      database,
      { app: { nodeEnv: 'test' } } as ApplicationConfigService,
      { error: jest.fn() } as unknown as StructuredLoggerService
    );
    const now = new Date('2026-10-05T12:00:00.000Z');

    await service.sweep(now);

    expect(database.webhookEvent.updateMany).toHaveBeenCalledTimes(2);
    expect(database.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'COMPLETED',
          completedAt: {
            lt: new Date(
              now.getTime() -
                COMPLETED_WEBHOOK_PAYLOAD_RETENTION_DAYS * 86400000
            ),
          },
        },
        data: { payload: {} },
      })
    );
    expect(database.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'FAILED',
          failedAt: {
            lt: new Date(
              now.getTime() - FAILED_WEBHOOK_PAYLOAD_RETENTION_DAYS * 86400000
            ),
          },
        },
      })
    );
    expect(database.auditLog.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          lt: new Date(
            now.getTime() - SECURITY_AUDIT_RETENTION_DAYS * 86400000
          ),
        },
      },
    });
    expect(database.telegramCallbackReference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { noteBodyEncrypted: null, noteContentFingerprint: null },
      })
    );
  });
});
