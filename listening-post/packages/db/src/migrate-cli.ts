// Entry point: applies pending migrations, then exits. Runs once before the API and worker start.
import { fileURLToPath } from 'node:url';
import { baseEnv, loadEnv } from '@lp/shared';
import { runMigrations } from './migrate';

const env = loadEnv(baseEnv);
// packages/db/src -> packages/db/drizzle in dev; dist -> drizzle inside the API image.
const folder = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../drizzle', import.meta.url));

runMigrations(env.DATABASE_URL, folder)
  .then(() => console.log(`migrations applied from ${folder}`))
  .catch((err: unknown) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
