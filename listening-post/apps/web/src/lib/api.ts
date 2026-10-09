// Server-only helpers for calling the Express API. The browser never talks to the API directly.

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    worker: { ok: boolean; workerId?: string; lastSeen?: string; ageMs?: number };
  };
}

function apiUrl(path: string): string {
  const base = process.env.API_URL ?? "http://localhost:3001";
  return new URL(path, base).toString();
}

/** Returns the API's health report, or null when the API itself cannot be reached. */
export async function getHealth(): Promise<HealthReport | null> {
  try {
    const res = await fetch(apiUrl("/health"), { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}
