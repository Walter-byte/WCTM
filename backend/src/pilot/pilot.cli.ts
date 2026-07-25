import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { AppModule } from '../app.module';
import { redactSensitiveText } from '../common/utils/redact-sensitive-data';
import {
  type PilotIdentityInput,
  PilotService,
  type PilotStoreInput,
} from './pilot.service';

class PrivatePromptOutput extends Writable {
  muted = false;

  constructor(private readonly destination: NodeJS.WriteStream) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.muted) {
      this.destination.write(chunk);
    }
    callback();
  }
}

class PilotPrompts {
  private readonly privateOutput = new PrivatePromptOutput(process.stdout);
  private readonly readline: Interface = createInterface({
    input: process.stdin,
    output: this.privateOutput,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  async identity(): Promise<PilotIdentityInput> {
    return {
      email: await this.visible('Pilot operator email: '),
      displayName: await this.visible('Pilot operator display name: '),
      tenantName: await this.visible('Pilot Tenant name: '),
    };
  }

  async store(): Promise<PilotStoreInput> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'WooCommerce credentials require an interactive TTY so input remains private'
      );
    }

    return {
      name: await this.visible('WooCommerce Store name: '),
      storeUrl: await this.visible('WooCommerce Store HTTPS URL: '),
      consumerKey: await this.privateValue(
        'WooCommerce REST consumer key (hidden): '
      ),
      consumerSecret: await this.privateValue(
        'WooCommerce REST consumer secret (hidden): '
      ),
    };
  }

  close(): void {
    this.readline.close();
  }

  private async visible(message: string): Promise<string> {
    return (await this.readline.question(message)).trim();
  }

  private async privateValue(message: string): Promise<string> {
    process.stdout.write(message);
    this.privateOutput.muted = true;

    try {
      return (await this.readline.question('')).trim();
    } finally {
      this.privateOutput.muted = false;
      process.stdout.write('\n');
    }
  }
}

async function runSetup(service: PilotService): Promise<void> {
  const prompts = new PilotPrompts();

  try {
    process.stdout.write(
      'Private-pilot setup: one User, one Tenant, one Store. No reset or overwrite is available.\n'
    );
    service.assertPilotEnvironment();
    process.stdout.write('[1/6] Pilot guard and public HTTPS endpoint: PASS\n');

    const identity = await service.bootstrapIdentity(await prompts.identity());
    process.stdout.write(
      `[2/6] User, Tenant, and OWNER Membership: ${identity.created ? 'CREATED' : 'EXISTS'}\n`
    );

    const credentialsRequired = await service.storeCredentialsRequired(
      identity.identity
    );
    const storeInput = credentialsRequired ? await prompts.store() : undefined;
    process.stdout.write(
      `[3/6] WooCommerce Store credentials: ${credentialsRequired ? 'RECEIVED PRIVATELY' : 'REUSED ENCRYPTED VALUES'}\n`
    );

    const result = await service.setup(identity, storeInput);
    process.stdout.write('[4/6] Store validation and activation: PASS\n');
    process.stdout.write('[5/6] Required WooCommerce order webhooks: PASS\n');

    if (result.alreadyLinked) {
      process.stdout.write(
        '[6/6] Telegram account: ALREADY LINKED — setup is complete\n'
      );
    } else {
      process.stdout.write(
        '[6/6] Telegram link token issued. Paste this once into the private bot chat:\n'
      );
      process.stdout.write(`${result.startCommand}\n`);
    }
    process.stdout.write(
      'Then create one clearly marked synthetic order in WooCommerce admin: use no real payment or customer and keep it in a non-terminal status. Run pilot:readiness afterward.\n'
    );
  } finally {
    prompts.close();
  }
}

async function runReadiness(service: PilotService): Promise<void> {
  process.stdout.write(
    'Private-pilot readiness (credentials, identifiers, and secrets are suppressed):\n'
  );
  const checks = await service.readiness();

  for (const check of checks) {
    process.stdout.write(`${check.pass ? 'PASS' : 'FAIL'} — ${check.label}\n`);
  }

  const failure = checks.find((check) => !check.pass);

  if (failure) {
    process.stderr.write(`Action required: ${failure.action}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    'PASS — private-pilot environment is ready for M12 V1\n'
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== 'setup' && command !== 'readiness') {
    throw new Error('Use only pilot:setup or pilot:readiness');
  }

  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const service = application.get(PilotService);

    if (command === 'setup') {
      await runSetup(service);
    } else {
      await runReadiness(service);
    }
  } finally {
    await application.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? redactSensitiveText(error.message)
      : 'Unknown error';

  process.stderr.write(`Pilot command failed: ${message}\n`);
  process.exitCode = 1;
});
