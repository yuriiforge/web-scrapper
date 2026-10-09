import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { deleteSourceAction, runSourceAction, setSourceEnabledAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { RunsTable } from "@/components/runs-table";
import { Card, PageHeader, SiteLabel, StatTile, buttonClass, num, primaryButtonClass, timeAgo } from "@/components/ui";
import { ApiError, fetchedNow, getSource, listClients, listRuns, listSources } from "@/lib/api";

export default function SourcePage({ params }: PageProps<"/sources/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading source…</p>}>
      <SourceBody params={params} />
    </Suspense>
  );
}

async function SourceBody({ params }: { params: PageProps<"/sources/[id]">["params"] }) {
  const { id } = await params;
  let loaded;
  try {
    loaded = await fetchedNow(Promise.all([getSource(id), listRuns({ sourceId: id, limit: 20 }), listSources(), listClients()]));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const {
    data: [source, runs, all, clients],
    now,
  } = loaded;
  const summary = all.find((s) => s.id === id);
  const client = clients.find((c) => c.id === source.clientId);
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  const finished = runs.filter((r) => r.status !== "queued" && r.status !== "running");
  const succeeded = finished.filter((r) => r.status === "succeeded").length;

  return (
    <div className="space-y-6">
      <AutoRefresh active={active} />
      <PageHeader
        title={source.name}
        description={
          <>
            <SiteLabel site={source.site} /> · {source.strategy} · {client?.name ?? "unknown client"}
            {!source.enabled && <strong className="ml-2">Disabled</strong>}
          </>
        }
        actions={
          <>
            <form action={runSourceAction}>
              <input type="hidden" name="sourceId" value={source.id} />
              <button type="submit" className={primaryButtonClass} disabled={!source.enabled}>
                Run now
              </button>
            </form>
            <Link href={`/sources/${source.id}/edit`} className={`${buttonClass} self-center`}>
              Edit
            </Link>
            <form action={setSourceEnabledAction}>
              <input type="hidden" name="sourceId" value={source.id} />
              <input type="hidden" name="enabled" value={String(!source.enabled)} />
              <button type="submit" className={`${buttonClass} h-full`}>
                {source.enabled ? "Disable" : "Enable"}
              </button>
            </form>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Items" value={num(summary?.itemCount ?? 0)} href={`/items?sourceId=${source.id}`} detail="browse them →" />
        <StatTile label="Schedule" value={<span className="font-mono text-lg">{source.schedule ?? "manual"}</span>} detail="cron, UTC" />
        <StatTile
          label="Recent runs"
          value={finished.length === 0 ? "–" : `${succeeded} of ${finished.length}`}
          detail="succeeded, of the last 20"
        />
        <StatTile
          label="Checkpoint"
          value={source.checkpoint ? timeAgo(source.checkpoint.updatedAt, now) : "none"}
          detail={source.checkpoint ? `strategy step: ${source.checkpoint.escalationStep ?? "–"}` : "the next run is a full crawl"}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Configuration">
          <pre className="overflow-x-auto text-xs">{JSON.stringify(source.config, null, 2)}</pre>
          {source.budgetUsdMonth !== null && <p className="mt-2 text-xs text-zinc-500">Monthly budget: ${source.budgetUsdMonth}</p>}
        </Card>
        <Card title="Checkpoint">
          {source.checkpoint ? (
            <pre className="overflow-x-auto text-xs">{JSON.stringify(source.checkpoint.cursor, null, 2)}</pre>
          ) : (
            <p className="text-sm text-zinc-500">No successful run yet, so the next run collects everything.</p>
          )}
          <p className="mt-2 text-xs text-zinc-500">Saved only when a run succeeds; the next run stops where it points.</p>
        </Card>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Last 20 runs</h2>
          <Link href={`/runs?sourceId=${source.id}`} className="text-xs text-zinc-500 hover:underline">
            All runs of this source →
          </Link>
        </div>
        <RunsTable runs={runs} now={now} showSource={false} />
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-500">Danger zone</summary>
        <form action={deleteSourceAction} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="sourceId" value={source.id} />
          <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950">
            Delete source
          </button>
          <span className="text-xs text-zinc-500">Deletes its runs, items and checkpoint too. This cannot be undone.</span>
        </form>
      </details>
    </div>
  );
}
