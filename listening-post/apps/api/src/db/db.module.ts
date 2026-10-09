import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type DbHandle } from '@lp/db';
import type { ApiEnv } from '../config';
import { API_ENV, DB, DB_HANDLE } from '../tokens';

/** One connection pool for the whole API, closed on shutdown. Inject `DB` to query. */
@Global()
@Module({
  providers: [
    { provide: DB_HANDLE, inject: [API_ENV], useFactory: (env: ApiEnv) => createDb(env.DATABASE_URL) },
    { provide: DB, inject: [DB_HANDLE], useFactory: (h: DbHandle) => h.db },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
