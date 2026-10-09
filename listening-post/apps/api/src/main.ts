import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { apiEnv, loadEnv } from '@lp/shared';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './setup';

async function bootstrap(): Promise<void> {
  const env = loadEnv(apiEnv);
  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.listen(env.API_PORT);
  app.get(Logger).log(`api listening on ${env.API_PORT}`);
}

void bootstrap();
