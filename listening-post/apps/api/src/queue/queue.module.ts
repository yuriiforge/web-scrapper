import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { startBoss, type PgBoss } from '@lp/queue';
import { Logger } from 'nestjs-pino';
import type { ApiEnv } from '../config';
import { API_ENV, QUEUE } from '../tokens';

/** pg-boss as a producer: the API only enqueues jobs, the worker runs them. */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE,
      inject: [API_ENV, Logger],
      useFactory: (env: ApiEnv, log: Logger) =>
        startBoss(env.DATABASE_URL, { role: 'producer', onError: (err) => log.error(err, 'queue error') }),
    },
  ],
  exports: [QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(QUEUE) private readonly boss: PgBoss) {}

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: false });
  }
}
