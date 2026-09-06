import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { EncryptionKeyRotationModule } from './encryption-key-rotation.module';
import {
  type EncryptionKeyRotationMode,
  EncryptionKeyRotationService,
} from './encryption-key-rotation.service';

const MODES = new Set<EncryptionKeyRotationMode>([
  'inspect',
  'rotate',
  'verify',
]);

function parseMode(arguments_: readonly string[]): EncryptionKeyRotationMode {
  if (
    arguments_.length !== 1 ||
    !MODES.has(arguments_[0] as EncryptionKeyRotationMode)
  ) {
    throw new Error('Use exactly one mode: inspect, rotate, or verify');
  }

  return arguments_[0] as EncryptionKeyRotationMode;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(
    EncryptionKeyRotationModule,
    { logger: false }
  );

  try {
    const report = await application
      .get(EncryptionKeyRotationService)
      .execute(mode);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await application.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    'Encryption-key rotation command failed; database state remains resumable.\n'
  );
  process.exitCode = 1;
});
