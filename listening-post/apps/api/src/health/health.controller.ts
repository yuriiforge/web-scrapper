import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HEALTH_DEPS } from '../tokens';
import { checkHealth, type HealthDeps, type HealthReport } from './health';

@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_DEPS) private readonly deps: HealthDeps) {}

  /** 503 only when the database is down; a missing worker heartbeat is reported but stays 200. */
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await checkHealth(this.deps);
    res.status(report.status === 'down' ? 503 : 200);
    return report;
  }
}
