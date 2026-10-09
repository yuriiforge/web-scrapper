import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Applies pending migrations from `migrationsFolder` and closes its connection. */
export async function runMigrations(url: string, migrationsFolder: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
