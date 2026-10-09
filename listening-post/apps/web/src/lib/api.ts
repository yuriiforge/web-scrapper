// Server-only helpers for calling the API. The browser never talks to the API directly.

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    worker: { ok: boolean; workerId?: string; lastSeen?: string; ageMs?: number };
  };
}

export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface Source {
  id: string;
  clientId: string;
  name: string;
  site: string;
  strategy: string;
  config: Record<string, unknown>;
  schedule: string | null;
  enabled: boolean;
  itemCount: number;
  lastRun: { id: string; status: RunStatus; createdAt: string; finishedAt: string | null; itemsNew: number; errorClass: string | null } | null;
}

export interface Run {
  id: string;
  sourceId: string;
  sourceName: string;
  site: string;
  trigger: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pages: number;
  itemsFound: number;
  itemsNew: number;
  errorClass: string | null;
  errorMessage: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`);
  }
}

function apiUrl(path: string): string {
  return new URL(path, process.env.API_URL ?? "http://localhost:3001").toString();
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { ...init, signal: AbortSignal.timeout(5000) });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? "error");
  return body as T;
}

/** The API's health report, or null when the API itself cannot be reached. */
export async function getHealth(): Promise<HealthReport | null> {
  try {
    const res = await fetch(apiUrl("/health"), { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}

export const listSources = () => call<Source[]>("/api/sources");

export function listRuns(opts: { sourceId?: string; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (opts.sourceId) q.set("sourceId", opts.sourceId);
  q.set("limit", String(opts.limit ?? 50));
  return call<Run[]>(`/api/runs?${q}`);
}

export const runSource = (id: string) => call<Run>(`/api/sources/${id}/runs`, { method: "POST" });

export const cancelRun = (id: string) => call<{ id: string }>(`/api/runs/${id}/cancel`, { method: "POST" });

/** Data plus the moment it was fetched, so pages can show "3 min ago" without reading the clock while rendering. */
export async function fetchedNow<T>(data: Promise<T>): Promise<{ data: T; now: number }> {
  const value = await data;
  return { data: value, now: Date.now() };
}
