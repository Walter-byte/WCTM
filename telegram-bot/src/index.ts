import { Bot } from 'grammy';

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const keepAliveTimer = setInterval(() => undefined, 60_000);

    for (const signal of shutdownSignals) {
      process.once(signal, () => {
        clearInterval(keepAliveTimer);
        resolve(signal);
      });
    }
  });
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required.');
  }

  const bot = new Bot(token);

  // Polling starts in the Telegram platform phase; this scaffold stays offline.
  bot.command('start', async (context) => {
    await context.reply('WC-Telegram-SaaS bot is being prepared.');
  });

  console.log('Bot started');

  const shutdownSignal = await waitForShutdown();
  console.log(`Bot received ${shutdownSignal}; shutting down gracefully.`);
}

void main().catch((error: unknown) => {
  console.error('Telegram bot failed to start.', error);
  process.exitCode = 1;
});
