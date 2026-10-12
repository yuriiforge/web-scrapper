// Server-only helpers for calling the API. The browser never talks to the API directly.

export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type Site = "threadit" | "agora" | "ratewell" | "chirp";

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    worker: { ok: boolean; workerId?: string; lastSeen?: string; ageMs?: number };
  };
}

export interface Client {
  id: string;
  name: string;
}

export interface LastRun {
  id: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  itemsNew: number;
  errorClass: string | null;
}

export interface Source {
  id: string;
  clientId: string;
  name: string;
  site: Site;
  strategy: string;
  config: Record<string, unknown>;
  schedule: string | null;
  enabled: boolean;
  budgetUsdMonth: number | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  lastRun: LastRun | null;
}

export interface SourceDetail extends Omit<Source, "itemCount" | "lastRun"> {
  checkpoint: { cursor: unknown; escalationStep: string | null; updatedAt: string } | null;
}

export interface Run {
  id: string;
  sourceId: string;
  sourceName: string;
  site: Site;
  trigger: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pages: number;
  requests: number;
  itemsFound: number;
  itemsNew: number;
  errorClass: string | null;
  errorMessage: string | null;
  /** The escalation-ladder step the run ended on. */
  strategy: string | null;
}

export interface RawResponseMeta {
  id: number;
  url: string;
  httpStatus: number;
  sha256: string;
  bodyStored: boolean;
  fetchedAt: string;
  expiresAt: string;
}

export interface Item {
  id: number;
  site: Site;
  externalId: string;
  author: string | null;
  text: string;
  country: string | null;
  publishedAt: string | null;
  collectedAt: string;
  sourceId: string;
  sourceName: string;
  meta: { rating?: number; verified?: boolean } & Record<string, unknown>;
}

export interface Overview {
  items: { total: number; last24h: number };
  sources: { total: number; enabled: number; failing: number };
  runs24h: Record<RunStatus, number>;
  requests24h: number;
  spendMonthUsd: number;
  attention: { sourceId: string; sourceName: string; runId: string; status: RunStatus; createdAt: string; errorClass: string | null; errorMessage: string | null }[];
  recentRuns: { id: string; sourceName: string; site: Site; status: RunStatus; createdAt: string; startedAt: string | null; finishedAt: string | null; itemsNew: number }[];
}

export interface CostRow {
  runs: number;
  requests: number;
  itemsNew: number;
  usd: number;
  usdPerNewItem: number | null;
}

export interface Costs {
  from: string;
  to: string;
  clients: (CostRow & { clientId: string; clientName: string })[];
  sources: (CostRow & { id: string; name: string; site: Site; strategy: string; clientId: string; clientName: string; budgetUsdMonth: number | null })[];
  providers: { provider: string; unit: string; units: number; usd: number }[];
}

export interface Volume {
  from: string;
  to: string;
  latestPublishedAt: string | null;
  days: string[];
  series: { site: Site; counts: number[] }[];
}

export interface SentimentGrid {
  scoredItems: number;
  categories: string[];
  cells: { country: string | null; category: string | null; n: number; positive: number; negative: number; net: number }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field?: string,
    readonly detail?: string,
  ) {
    super(`API ${status}: ${code}${field ? ` (${field})` : ""}`);
  }
}

function apiUrl(path: string): string {
  return new URL(path, process.env.API_URL ?? "http://localhost:3001").toString();
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    const e = (body ?? {}) as { error?: string; field?: string; message?: string };
    throw new ApiError(res.status, e.error ?? "error", e.field, e.message);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** The API's health report, or null when the API itself cannot be reached. */
export async function getHealth(): Promise<HealthReport | null> {
  try {
    const res = await fetch(apiUrl("/health"), { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}

export const getOverview = () => call<Overview>("/api/overview");
export const listClients = () => call<Client[]>("/api/clients");
export const listSources = () => call<Source[]>("/api/sources");
export const getSource = (id: string) => call<SourceDetail>(`/api/sources/${id}`);
export const createSource = (body: unknown) => call<SourceDetail>("/api/sources", { method: "POST", body: JSON.stringify(body) });
export const updateSource = (id: string, body: unknown) =>
  call<SourceDetail>(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteSource = (id: string) => call<null>(`/api/sources/${id}`, { method: "DELETE" });
export const runSource = (id: string) => call<Run>(`/api/sources/${id}/runs`, { method: "POST" });

export const listRuns = (opts: { sourceId?: string; limit?: number } = {}) =>
  call<Run[]>(`/api/runs${qs({ sourceId: opts.sourceId, limit: opts.limit ?? 50 })}`);
export const getRun = (id: string) => call<Run>(`/api/runs/${id}`);
export const getRunRaw = (id: string) => call<RawResponseMeta[]>(`/api/runs/${id}/raw`);
export const cancelRun = (id: string) => call<{ id: string }>(`/api/runs/${id}/cancel`, { method: "POST" });

export interface ItemFilters {
  site?: string;
  sourceId?: string;
  country?: string;
  q?: string;
  cursor?: string;
}
export const listItems = (f: ItemFilters) => call<{ items: Item[]; nextCursor: string | null }>(`/api/items${qs({ ...f, limit: 50 })}`);

export const getCosts = (days: number) => call<Costs>(`/api/costs${qs({ days })}`);
export const getVolume = (days: number) => call<Volume>(`/api/insights/volume${qs({ days })}`);
export const getCountries = (days: number) => call<{ countries: { country: string | null; n: number }[] }>(`/api/insights/countries${qs({ days })}`);
export const getSourceVolume = (days: number) =>
  call<{ sources: { sourceId: string; sourceName: string; site: Site; clientName: string; n: number }[] }>(`/api/insights/sources${qs({ days })}`);
export const getSentiment = (days: number) => call<SentimentGrid>(`/api/insights/sentiment${qs({ days })}`);

/** Data plus the moment it was fetched, so pages can show "3 min ago" without reading the clock while rendering. */
export async function fetchedNow<T>(data: Promise<T>): Promise<{ data: T; now: number }> {
  const value = await data;
  return { data: value, now: Date.now() };
}
