import { WORKER_STALE_AFTER_MS } from '@lp/shared';

export interface HealthDeps {
  pingDb: () => Promise<void>;
  latestHeartbeat: () => Promise<{ workerId: string; lastSeen: Date } | null>;
  now?: () => number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    worker: { ok: boolean; workerId?: string; lastSeen?: string; ageMs?: number };
  };
}

/**
 * `down` when the database is unreachable; `degraded` when the database is fine but no
 * worker has sent a heartbeat recently. Only `down` should fail a container healthcheck,
 * so a stopped worker never takes the API down with it.
 */
export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  try {
    await deps.pingDb();
  } catch (err) {
    return {
      status: 'down',
      checks: { database: { ok: false, error: err instanceof Error ? err.message : String(err) }, worker: { ok: false } },
    };
  }
  const database = { ok: true, latencyMs: now() - started };

  const beat = await deps.latestHeartbeat();
  const ageMs = beat ? now() - beat.lastSeen.getTime() : undefined;
  const worker =
    beat && ageMs !== undefined
      ? { ok: ageMs <= WORKER_STALE_AFTER_MS, workerId: beat.workerId, lastSeen: beat.lastSeen.toISOString(), ageMs }
      : { ok: false };

  return { status: worker.ok ? 'ok' : 'degraded', checks: { database, worker } };
}
