import { BOT_COMMANDS, createBot } from './bot';
import { loadBotConfiguration } from './config';
import { InternalBackendClient } from './internal-backend.client';
import { InternalDeliveryServer } from './internal-delivery.server';

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const MAX_POLLING_ATTEMPTS = 3;
const POLLING_BACKOFF_BASE_MS = 1_000;

async function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const signal of shutdownSignals) {
      process.once(signal, () => {
        resolve(signal);
      });
    }
  });
}

async function main(): Promise<void> {
  const configuration = loadBotConfiguration(process.env);
  const backend = new InternalBackendClient(configuration);
  const bot = createBot(configuration.botToken, {
    backend,
    log: (record) => {
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'log',
          ...record,
        })}\n`
      );
    },
  });
  const deliveryServer = new InternalDeliveryServer(configuration, bot.api);

  await deliveryServer.start();

  try {
    await configureCommandMenu(bot);
    const polling = startPollingWithRetry(bot);
    const outcome = await Promise.race([
      waitForShutdown().then((signal) => ({ signal })),
      polling.then(() => ({ signal: undefined })),
    ]);

    if (!outcome.signal) {
      throw new Error('Telegram polling stopped unexpectedly');
    }

    const shutdownSignal = outcome.signal;
    bot.stop();
    await polling;
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'log',
        event: 'telegram_bot_stopping',
        signal: shutdownSignal,
      })}\n`
    );
  } finally {
    await deliveryServer.close();
  }
}

async function configureCommandMenu(
  bot: ReturnType<typeof createBot>
): Promise<void> {
  try {
    await bot.api.setMyCommands([...BOT_COMMANDS]);
  } catch (error: unknown) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        event: 'telegram_command_menu_configuration_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })}\n`
    );
  }
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'telegram_bot_failed',
      errorName,
    })}\n`
  );
  process.exitCode = 1;
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startPollingWithRetry(
  bot: ReturnType<typeof createBot>
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_POLLING_ATTEMPTS; attempt += 1) {
    try {
      await bot.start({
        onStart: () => {
          process.stdout.write(
            `${JSON.stringify({
              timestamp: new Date().toISOString(),
              level: 'log',
              event: 'telegram_bot_polling_started',
            })}\n`
          );
        },
      });
      return;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';

      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'telegram_bot_polling_failed',
          attempt,
          errorName,
        })}\n`
      );

      if (attempt >= MAX_POLLING_ATTEMPTS) {
        throw new Error('Telegram polling is unavailable');
      }

      await delay(POLLING_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
}
