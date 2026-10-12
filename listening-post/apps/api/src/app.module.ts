import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ApiTokenGuard } from './common/api-token.guard';
import type { ApiEnv } from './config';
import { ClientsModule } from './clients/clients.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { ReportsModule } from './reports.module';
import { RunsModule } from './runs/runs.module';
import { SourcesModule } from './sources/sources.module';
import { API_ENV } from './tokens';

@Module({})
export class AppModule {
  /** The root module, built from validated environment so nothing reads process.env later. */
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            base: { service: 'api' },
            autoLogging: { ignore: (req) => req.url === '/health' },
          },
        }),
        DbModule,
        QueueModule,
        HealthModule,
        ClientsModule,
        SourcesModule,
        RunsModule,
        ReportsModule,
      ],
      providers: [{ provide: API_ENV, useValue: env }, { provide: APP_GUARD, useClass: ApiTokenGuard }],
      exports: [API_ENV],
    };
  }
}
