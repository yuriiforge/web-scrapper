import { Suspense } from "react";
import { getHealth } from "@/lib/api";

export default function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">System status</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Whether the API, database and worker are connected. Sources and runs are in the menu;
          costs and insights arrive in later build steps.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Checking services…</p>}>
        <StatusPanel />
      </Suspense>
    </div>
  );
}

async function StatusPanel() {
  const health = await getHealth();
  const rows: { name: string; ok: boolean; detail: string }[] = [
    {
      name: "API",
      ok: health !== null,
      detail: health ? `status ${health.status}` : "unreachable",
    },
    {
      name: "Database",
      ok: health?.checks.database.ok ?? false,
      detail: health?.checks.database.ok
        ? `${health.checks.database.latencyMs} ms`
        : (health?.checks.database.error ?? "unknown"),
    },
    {
      name: "Worker",
      ok: health?.checks.worker.ok ?? false,
      detail: health?.checks.worker.lastSeen
        ? `last heartbeat ${Math.round((health.checks.worker.ageMs ?? 0) / 1000)} s ago`
        : "no heartbeat yet",
    },
  ];

  return (
    <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center justify-between px-4 py-3">
          <span className="flex items-center gap-3">
            <span
              aria-hidden
              className={`h-2.5 w-2.5 rounded-full ${row.ok ? "bg-emerald-500" : "bg-red-500"}`}
            />
            <span className="font-medium">{row.name}</span>
          </span>
          <span className="text-sm text-zinc-500">
            <span className="sr-only">{row.ok ? "healthy: " : "unhealthy: "}</span>
            {row.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
