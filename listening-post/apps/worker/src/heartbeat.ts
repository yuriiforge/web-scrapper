import { writeFile } from 'node:fs/promises';
import type { Logger } from 'pino';

export interface HeartbeatDeps {
  log: Logger;
  intervalMs: number;
  /** Records liveness in the database, where the API health check reads it. */
  beat: () => Promise<void>;
  /** Touched on every successful beat; the container healthcheck reads its age. */
  file: string;
}

/** Beats now and then every `intervalMs`. Returns a function that stops it. */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  const tick = async () => {
    try {
      await deps.beat();
      await writeFile(deps.file, new Date().toISOString());
    } catch (err) {
      deps.log.warn({ err }, 'heartbeat failed');
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);
  return () => clearInterval(timer);
}
