// Entry point: adds two demo clients with Threadit sources. Safe to run repeatedly.
import { baseEnv, loadEnv } from '@lp/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from './client';
import { clients, sources } from './schema';

const DEMO: { client: string; sources: { name: string; community: string; schedule: string | null }[] }[] = [
  {
    client: 'Northwind Outdoors',
    sources: [
      { name: 'Threadit · gb', community: 'gb', schedule: '*/15 * * * *' },
      { name: 'Threadit · electric_cars', community: 'electric_cars', schedule: '*/30 * * * *' },
    ],
  },
  {
    client: 'Bluefin Media',
    sources: [
      { name: 'Threadit · de', community: 'de', schedule: '0 * * * *' },
      { name: 'Threadit · online_banks', community: 'online_banks', schedule: null },
    ],
  },
];

const env = loadEnv(baseEnv);
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });

try {
  for (const demo of DEMO) {
    const [client] = await db
      .insert(clients)
      .values({ name: demo.client })
      .onConflictDoUpdate({ target: clients.name, set: { name: sql`excluded.name` } })
      .returning({ id: clients.id });
    for (const s of demo.sources) {
      const existing = await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.clientId, client!.id), eq(sources.name, s.name)));
      if (existing.length > 0) continue;
      await db.insert(sources).values({
        clientId: client!.id,
        name: s.name,
        site: 'threadit',
        strategy: 'api',
        schedule: s.schedule,
        config: { community: s.community, pageSize: 100, includeComments: true },
      });
    }
  }
  console.log('demo clients and sources ready');
} finally {
  await close();
}
