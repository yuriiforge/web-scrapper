// Entry point: adds two demo clients with a few sources each. Safe to run repeatedly:
// existing clients and sources (matched by name) are left as they are.
import { baseEnv, loadEnv, type Site, type Strategy } from '@lp/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from './client';
import { clients, sources } from './schema';

interface DemoSource {
  name: string;
  site: Site;
  strategy: Strategy;
  schedule: string | null;
  config: Record<string, unknown>;
  budgetUsdMonth?: number;
}

const threadit = (community: string, schedule: string | null): DemoSource => ({
  name: `Threadit · ${community}`,
  site: 'threadit',
  strategy: 'api',
  schedule,
  config: { community, pageSize: 100, includeComments: true },
});

const agora = (category: string, format: 'json' | 'html', schedule: string | null): DemoSource => ({
  name: `Agora · ${category}${format === 'html' ? ' (HTML)' : ''}`,
  site: 'agora',
  strategy: 'html',
  schedule,
  config: { category, format },
});

const ratewell = (company: string, schedule: string | null, budgetUsdMonth?: number): DemoSource => ({
  name: `Ratewell · ${company}`,
  site: 'ratewell',
  strategy: 'html',
  schedule,
  config: { company },
  budgetUsdMonth,
});

const chirp = (query: string, country: string, schedule: string | null, budgetUsdMonth: number): DemoSource => ({
  name: `Chirp · "${query}" (${country})`,
  site: 'chirp',
  strategy: 'api',
  schedule,
  config: { query, country },
  budgetUsdMonth,
});

const DEMO: { client: string; sources: DemoSource[] }[] = [
  {
    client: 'Northwind Outdoors',
    sources: [
      threadit('gb', '*/15 * * * *'),
      threadit('electric_cars', '*/30 * * * *'),
      agora('meal-kits', 'json', '*/20 * * * *'),
      ratewell('voltra-motors', '0 */6 * * *'),
      chirp('delivery', 'GB', '5 * * * *', 2),
    ],
  },
  {
    client: 'Bluefin Media',
    sources: [
      threadit('de', '0 * * * *'),
      threadit('online_banks', null),
      agora('online-banks', 'html', '0 * * * *'),
      // A budget, so escalation to the paid unblocker is capped at $1 a month.
      ratewell('ledgerly', '0 */6 * * *', 1),
      chirp('bank', 'PL', '35 * * * *', 1),
    ],
  },
];

const env = loadEnv(baseEnv);
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });

try {
  let added = 0;
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
      await db.insert(sources).values({ clientId: client!.id, ...s });
      added += 1;
    }
  }
  console.log(`demo clients and sources ready (${added} added)`);
} finally {
  await close();
}
