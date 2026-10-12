import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** `days=N` back from now, or an explicit `from`/`to`; defaults to the last 30 days. */
export const periodQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type PeriodQuery = z.infer<typeof periodQuery>;

export interface Period {
  from: Date;
  to: Date;
}

/** An open-ended period runs this far past now, so rows written a moment ago count even if the database clock is slightly ahead. */
const OPEN_END_SLACK_MS = 60_000;

export function resolvePeriod(q: PeriodQuery, defaultDays = 30, now = new Date()): Period {
  const end = q.to ? new Date(q.to) : now;
  const to = q.to ? end : new Date(now.getTime() + OPEN_END_SLACK_MS);
  const from = q.from ? new Date(q.from) : new Date(end.getTime() - (q.days ?? defaultDays) * 86_400_000);
  if (from >= to) throw new BadRequestException({ error: 'bad_request', field: 'from', message: 'from must be before to' });
  return { from, to };
}

/** Start of the current calendar month, UTC. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
