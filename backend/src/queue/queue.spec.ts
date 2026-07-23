import { describe, expect, it, jest } from '@jest/globals';
import type { Job } from 'bullmq';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { TenantContextService } from '../tenant/tenant-context.service';
import { REFERENCE_JOB_ATTEMPTS, REFERENCE_JOB_NAME } from './queue.constants';
import { QueueRuntimeService } from './queue-runtime.service';
import { ReferenceJobProducer } from './reference-job.producer';
import {
  type ReferenceJobData,
  type ReferenceJobResult,
  ReferenceProcessor,
} from './reference.processor';
import type { WooCommerceWebhookProcessor } from './woocommerce-webhook.processor';

type ReferenceJob = Job<
  ReferenceJobData,
  ReferenceJobResult,
  typeof REFERENCE_JOB_NAME
>;

function job(data: Partial<ReferenceJobData>, attemptsMade = 0): ReferenceJob {
  return {
    id: 'job_1',
    name: REFERENCE_JOB_NAME,
    data,
    attemptsMade,
    opts: { attempts: REFERENCE_JOB_ATTEMPTS },
  } as ReferenceJob;
}

const webhookProcessor = (): WooCommerceWebhookProcessor =>
  ({
    markFailed: jest.fn().mockResolvedValue(undefined as never),
  }) as unknown as WooCommerceWebhookProcessor;

describe('M5 operations queue', () => {
  it('enqueues a reference job with tenant identity from server context', async () => {
    const addReferenceJob = jest.fn().mockResolvedValue({ id: '42' } as never);
    const runtime = { addReferenceJob } as unknown as QueueRuntimeService;
    const tenantContext = {
      active: {
        tenantId: 'ten_a',
        userId: 'usr_a',
        membershipRole: 'OWNER',
      },
    } as TenantContextService;
    const producer = new ReferenceJobProducer(runtime, tenantContext);

    await expect(producer.enqueue({ storeId: 'sto_a' })).resolves.toEqual({
      jobId: '42',
    });
    expect(addReferenceJob).toHaveBeenCalledWith({
      tenantId: 'ten_a',
      storeId: 'sto_a',
    });
  });

  it('executes a valid reference job successfully', async () => {
    const processor = new ReferenceProcessor();

    await expect(
      processor.process(job({ tenantId: 'ten_a', storeId: 'sto_a' }))
    ).resolves.toEqual({
      tenantId: 'ten_a',
      storeId: 'sto_a',
      processed: true,
      attempt: 1,
    });
  });

  it('throws for a transient attempt and succeeds on retry', async () => {
    const processor = new ReferenceProcessor();
    const data = { tenantId: 'ten_a', failUntilAttempt: 1 };

    await expect(processor.process(job(data, 0))).rejects.toThrow(
      'Reference job transient failure'
    );
    await expect(processor.process(job(data, 1))).resolves.toMatchObject({
      processed: true,
      attempt: 2,
    });
  });

  it('logs a structured error only after retry exhaustion', async () => {
    const error = jest.fn();
    const logger = { error } as unknown as StructuredLoggerService;
    const configuration = {
      app: { nodeEnv: 'test' },
      redis: { url: 'redis://localhost:6379' },
    } as ApplicationConfigService;
    const runtime = new QueueRuntimeService(
      configuration,
      new ReferenceProcessor(),
      webhookProcessor(),
      logger
    );

    await runtime.handleFailed(
      job({ tenantId: 'ten_a' }, REFERENCE_JOB_ATTEMPTS - 1),
      new Error('transient')
    );
    expect(error).not.toHaveBeenCalled();

    await runtime.handleFailed(
      job({ tenantId: 'ten_a' }, REFERENCE_JOB_ATTEMPTS),
      new Error('terminal secret-safe failure')
    );
    expect(error).toHaveBeenCalledWith(
      'Background job exhausted retry attempts',
      expect.objectContaining({ tenantId: 'ten_a', attempts: 3 }),
      QueueRuntimeService.name
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'terminal secret-safe failure'
    );
  });

  it('rejects missing and invalid tenant identity', async () => {
    const processor = new ReferenceProcessor();

    await expect(processor.process(job({}))).rejects.toThrow('tenantId');
    await expect(
      processor.process(job({ tenantId: 'tenant-from-client' }))
    ).rejects.toThrow('tenantId');
  });

  it('closes the worker before the queue during application shutdown', async () => {
    const closeWorker = jest.fn().mockResolvedValue(undefined as never);
    const closeQueue = jest.fn().mockResolvedValue(undefined as never);
    const runtime = new QueueRuntimeService(
      {
        app: { nodeEnv: 'test' },
        redis: { url: 'redis://localhost:6379' },
      } as ApplicationConfigService,
      new ReferenceProcessor(),
      webhookProcessor(),
      { error: jest.fn() } as unknown as StructuredLoggerService
    );

    Object.assign(runtime, {
      worker: { close: closeWorker },
      queue: { close: closeQueue },
    });

    await runtime.onApplicationShutdown();

    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(closeWorker.mock.invocationCallOrder[0]).toBeLessThan(
      closeQueue.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });

  it('increments a Redis fixed window atomically through a named Lua command', async () => {
    const defineCommand = jest.fn();
    const runCommand = jest.fn().mockResolvedValue(3 as never);
    const client = { defineCommand, runCommand };
    const runtime = new QueueRuntimeService(
      {
        app: { nodeEnv: 'test' },
        redis: { url: 'redis://localhost:6379' },
      } as ApplicationConfigService,
      new ReferenceProcessor(),
      webhookProcessor(),
      { error: jest.fn() } as unknown as StructuredLoggerService
    );

    Object.assign(runtime, {
      queue: { client: Promise.resolve(client) },
    });

    await expect(runtime.incrementFixedWindow('fixed:key', 60)).resolves.toBe(
      3
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'm7IncrementFixedWindow',
      expect.objectContaining({ numberOfKeys: 1 })
    );
    expect(runCommand).toHaveBeenCalledWith('m7IncrementFixedWindow', [
      'fixed:key',
      '60',
    ]);
  });
});
