import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, PageHeader, StatTile, StatusBadge, duration, num, timeAgo, usd } from "@/components/ui";
import { fetchedNow, getHealth, getOverview } from "@/lib/api";

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Collection health across all clients: what came in, what ran, what needs attention." />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <OverviewBody />
      </Suspense>
    </div>
  );
}

async function OverviewBody() {
  const [{ data: o, now }, health] = await Promise.all([fetchedNow(getOverview()), getHealth()]);
  const active = o.runs24h.queued + o.runs24h.running > 0;
  const finished24h = o.runs24h.succeeded + o.runs24h.partial + o.runs24h.failed;

  return (
    <>
      <AutoRefresh active={active} intervalMs={5000} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Items collected" value={num(o.items.total)} detail={`+${num(o.items.last24h)} in the last 24 h`} href="/items" />
        <StatTile
          label="Runs, last 24 h"
          value={num(finished24h)}
          detail={`${o.runs24h.succeeded} succeeded · ${o.runs24h.failed} failed${active ? ` · ${o.runs24h.running + o.runs24h.queued} active` : ""}`}
          href="/runs"
        />
        <StatTile label="Sources" value={`${o.sources.enabled} of ${o.sources.total}`} detail={o.sources.failing > 0 ? `${o.sources.failing} failing` : "enabled, none failing"} href="/sources" />
        <StatTile label="Spend this month" value={usd(o.spendMonthUsd)} detail={`${num(o.requests24h)} requests in the last 24 h`} href="/costs" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="System">
          <ul className="space-y-2 text-sm">
            {[
              { name: "API", ok: health !== null, detail: health ? `status ${health.status}` : "unreachable" },
              { name: "Database", ok: health?.checks.database.ok ?? false, detail: health?.checks.database.ok ? `${health.checks.database.latencyMs} ms` : (health?.checks.database.error ?? "unknown") },
              {
                name: "Worker",
                ok: health?.checks.worker.ok ?? false,
                detail: health?.checks.worker.lastSeen ? `heartbeat ${Math.round((health.checks.worker.ageMs ?? 0) / 1000)} s ago` : "no heartbeat yet",
              },
            ].map((row) => (
              <li key={row.name} className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${row.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                  {row.name}
                </span>
                <span className="text-zinc-500">
                  {row.ok ? "OK" : "Problem"} · {row.detail}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Needs attention">
          {o.attention.length === 0 ? (
            <p className="text-sm text-zinc-500">Every enabled source&apos;s last run succeeded.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {o.attention.map((a) => (
                <li key={a.sourceId}>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={a.status} />
                    <Link href={`/sources/${a.sourceId}`} className="font-medium hover:underline">
                      {a.sourceName}
                    </Link>
                    <span className="text-xs text-zinc-500">{timeAgo(a.createdAt, now)}</span>
                  </div>
                  {a.errorClass && (
                    <Link href={`/runs/${a.runId}`} className="mt-1 block text-xs text-red-700 hover:underline dark:text-red-400">
                      {a.errorClass}: {a.errorMessage?.slice(0, 140)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent runs">
        {o.recentRuns.length === 0 ? (
          <p className="text-sm text-zinc-500">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {o.recentRuns.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusBadge status={r.status} />
                  <Link href={`/runs/${r.id}`} className="truncate hover:underline">
                    {r.sourceName}
                  </Link>
                </span>
                <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                  {num(r.itemsNew)} new · {duration(r.startedAt, r.finishedAt, now)} · {timeAgo(r.createdAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/runs" className="mt-3 inline-block text-xs text-zinc-500 hover:underline">
          All runs →
        </Link>
      </Card>
    </>
  );
}
