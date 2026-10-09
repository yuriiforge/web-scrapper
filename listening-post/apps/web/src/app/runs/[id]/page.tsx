import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { cancelRunAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, PageHeader, StatTile, StatusBadge, buttonClass, duration, num, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import { ApiError, fetchedNow, getRun, getRunRaw } from "@/lib/api";

export default function RunPage({ params }: PageProps<"/runs/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading run…</p>}>
      <RunBody params={params} />
    </Suspense>
  );
}

async function RunBody({ params }: { params: PageProps<"/runs/[id]">["params"] }) {
  const { id } = await params;
  let loaded;
  try {
    loaded = await fetchedNow(Promise.all([getRun(id), getRunRaw(id)]));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const {
    data: [run, raw],
    now,
  } = loaded;
  const active = run.status === "queued" || run.status === "running";

  return (
    <div className="space-y-6">
      <AutoRefresh active={active} />
      <PageHeader
        title={`Run of ${run.sourceName}`}
        description={
          <>
            <StatusBadge status={run.status} /> <span className="ml-1">{run.trigger} run, created {timeAgo(run.createdAt, now)}</span> ·{" "}
            <Link href={`/sources/${run.sourceId}`} className="underline">
              source
            </Link>
          </>
        }
        actions={
          active ? (
            <form action={cancelRunAction}>
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit" className={buttonClass}>
                Cancel run
              </button>
            </form>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Took" value={duration(run.startedAt, run.finishedAt, now)} />
        <StatTile label="Pages" value={num(run.pages)} />
        <StatTile label="Requests" value={num(run.requests)} detail="including retries and 304s" />
        <StatTile label="New items" value={num(run.itemsNew)} detail={`of ${num(run.itemsFound)} seen`} />
      </div>

      {run.errorClass && (
        <Card title="Error">
          <p className="text-sm">
            <span className="font-mono text-red-700 dark:text-red-400">{run.errorClass}</span>
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-600 dark:text-zinc-400">{run.errorMessage}</pre>
        </Card>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Raw responses ({num(raw.length)})</h2>
        <p className="text-xs text-zinc-500">
          Stored before parsing, so a broken parser can be fixed and re-run against them. 304 responses are not stored. Bodies identical to
          the previous fetch of the same URL are not stored again.
        </p>
        {raw.length === 0 ? (
          <p className="text-sm text-zinc-500">None stored.</p>
        ) : (
          <table className={tableClass}>
            <thead className="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className={thClass}>URL</th>
                <th className={`${thClass} text-right`}>Status</th>
                <th className={thClass}>Body</th>
                <th className={thClass}>Fetched</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 font-mono text-xs dark:divide-zinc-800">
              {raw.slice(0, 200).map((r) => (
                <tr key={r.id}>
                  <td className={`${tdClass} max-w-md truncate`} title={r.url}>
                    {r.url.replace(/^https?:\/\/[^/]+/, "")}
                  </td>
                  <td className={`${tdClass} text-right`}>{r.httpStatus}</td>
                  <td className={tdClass}>{r.bodyStored ? "stored" : "unchanged"}</td>
                  <td className={`${tdClass} text-zinc-500`}>{timeAgo(r.fetchedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {raw.length > 200 && <p className="text-xs text-zinc-500">Showing the first 200.</p>}
      </div>
    </div>
  );
}
