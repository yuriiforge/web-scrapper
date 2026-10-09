import Link from "next/link";
import { Suspense } from "react";
import { runSourceAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge, buttonClass, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import { fetchedNow, listSources } from "@/lib/api";

export default function SourcesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Sources</h1>
        <p className="mt-1 text-sm text-zinc-500">What is collected, how often, and how the last run went.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading sources…</p>}>
        <SourcesTable />
      </Suspense>
    </div>
  );
}

async function SourcesTable() {
  const { data: sources, now } = await fetchedNow(listSources());
  if (sources.length === 0) return <p className="text-sm text-zinc-500">No sources yet.</p>;
  const active = sources.some((s) => s.lastRun && (s.lastRun.status === "queued" || s.lastRun.status === "running"));

  return (
    <>
      <AutoRefresh active={active} />
      <table className={tableClass}>
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th className={thClass}>Source</th>
            <th className={thClass}>Schedule</th>
            <th className={`${thClass} text-right`}>Items</th>
            <th className={thClass}>Last run</th>
            <th className={thClass}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sources.map((s) => (
            <tr key={s.id}>
              <td className={tdClass}>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  {s.site} · {s.strategy}
                  {!s.enabled && " · disabled"}
                </div>
              </td>
              <td className={`${tdClass} font-mono text-xs`}>{s.schedule ?? "manual"}</td>
              <td className={`${tdClass} text-right tabular-nums`}>{s.itemCount.toLocaleString("en-GB")}</td>
              <td className={tdClass}>
                {s.lastRun ? (
                  <Link href={`/runs?sourceId=${s.id}`} className="flex items-center gap-2 hover:underline">
                    <StatusBadge status={s.lastRun.status} />
                    <span className="text-xs text-zinc-500">{timeAgo(s.lastRun.createdAt, now)}</span>
                  </Link>
                ) : (
                  <span className="text-xs text-zinc-500">never run</span>
                )}
              </td>
              <td className={`${tdClass} text-right`}>
                <form action={runSourceAction}>
                  <input type="hidden" name="sourceId" value={s.id} />
                  <button type="submit" className={buttonClass} disabled={!s.enabled}>
                    Run now
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
