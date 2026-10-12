import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiEnv } from '../config';
import { API_ENV } from '../tokens';

/**
 * Every /api route needs `Authorization: Bearer <API_TOKEN>`. Only the dashboard's server holds the
 * token; browsers never call the API directly. /health stays open for container healthchecks.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.expected = env.API_TOKEN ? Buffer.from(env.API_TOKEN) : null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path === '/health') return true;
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    const given = m ? Buffer.from(m[1]!) : Buffer.alloc(0);
    // Constant-time comparison, so response timing does not leak how much of a guess was right.
    if (given.length !== this.expected.length || !timingSafeEqual(given, this.expected)) {
      throw new UnauthorizedException({ error: 'unauthorized' });
    }
    return true;
  }
}
