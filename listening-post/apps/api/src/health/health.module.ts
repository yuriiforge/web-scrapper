import { Module } from '@nestjs/common';
import { latestHeartbeat, pingDb, type Db } from '@lp/db';
import { DB, HEALTH_DEPS } from '../tokens';
import type { HealthDeps } from './health';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_DEPS,
      inject: [DB],
      useFactory: (db: Db): HealthDeps => ({ pingDb: () => pingDb(db), latestHeartbeat: () => latestHeartbeat(db) }),
    },
  ],
})
export class HealthModule {}
