import Link from "next/link";
import { Suspense } from "react";
import { runSourceAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader, SiteLabel, StatusBadge, buttonClass, num, primaryButtonClass, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import { fetchedNow, listClients, listSources } from "@/lib/api";

export default function SourcesPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Sources"
        description="What is collected, for which client, how often, and how the last run went."
        actions={
          <Link href="/sources/new" className={primaryButtonClass}>
            Add source
          </Link>
        }
      />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading sources…</p>}>
        <SourcesTable />
      </Suspense>
    </div>
  );
}

async function SourcesTable() {
  const [{ data: sources, now }, clients] = await Promise.all([fetchedNow(listSources()), listClients()]);
  if (sources.length === 0) return <p className="text-sm text-zinc-500">No sources yet.</p>;
  const active = sources.some((s) => s.lastRun && (s.lastRun.status === "queued" || s.lastRun.status === "running"));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  return (
    <>
      <AutoRefresh active={active} />
      <table className={tableClass}>
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th className={thClass}>Source</th>
            <th className={thClass}>Client</th>
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
            <tr key={s.id} className={s.enabled ? "" : "opacity-60"}>
              <td className={tdClass}>
                <Link href={`/sources/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <div className="text-xs text-zinc-500">
                  <SiteLabel site={s.site} /> · {s.strategy}
                  {!s.enabled && " · disabled"}
                </div>
              </td>
              <td className={`${tdClass} text-xs`}>{clientName.get(s.clientId) ?? "–"}</td>
              <td className={`${tdClass} font-mono text-xs`}>{s.schedule ?? "manual"}</td>
              <td className={`${tdClass} text-right tabular-nums`}>
                <Link href={`/items?sourceId=${s.id}`} className="hover:underline">
                  {num(s.itemCount)}
                </Link>
              </td>
              <td className={tdClass}>
                {s.lastRun ? (
                  <Link href={`/runs/${s.lastRun.id}`} className="flex items-center gap-2 hover:underline">
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
