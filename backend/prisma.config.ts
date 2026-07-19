import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const backendDirectory = fileURLToPath(new URL('.', import.meta.url));

config({ path: `${backendDirectory}../.env`, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
