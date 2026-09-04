import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../app.module';
import { redactSensitiveText } from '../common/utils/redact-sensitive-data';
import { EntitlementService } from './entitlement.service';
import { parseEntitlementArguments } from './entitlement-cli-arguments';

async function main(): Promise<void> {
  const input = parseEntitlementArguments(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const service = application.get(EntitlementService);
    const result = await service.manage({
      ...input,
      correlationId: `entitlement-command-${randomUUID()}`,
    });
    process.stdout.write(
      `${JSON.stringify({
        tenantFingerprint: service.fingerprint(input.tenantId),
        plan: result.plan,
        persistedStatus: result.status,
        effectiveState: result.effectiveState,
        expiresAt: result.expiresAt,
      })}\n`
    );
  } finally {
    await application.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? redactSensitiveText(error.message)
      : 'Unknown error';
  process.stderr.write(`Entitlement command failed: ${message}\n`);
  process.exitCode = 1;
});
