import type { INestApplication } from '@nestjs/common';
import { HttpExceptionFilter } from './common/http-exception.filter';

/** Settings shared by main.ts and the tests, so tests exercise the real app shape. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  (app.getHttpAdapter().getInstance() as { disable(name: string): void }).disable('x-powered-by');
}
