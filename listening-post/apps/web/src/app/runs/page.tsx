import Link from "next/link";
import { Suspense } from "react";
import { cancelRunAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatusBadge, buttonClass, duration, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import { fetchedNow, listRuns } from "@/lib/api";

export default function RunsPage({ searchParams }: PageProps<"/runs">) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="mt-1 text-sm text-zinc-500">Newest first. Updates every 3 seconds while a run is active.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading runs…</p>}>
        <RunsTable searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function RunsTable({ searchParams }: { searchParams: PageProps<"/runs">["searchParams"] }) {
  const { sourceId } = await searchParams;
  const { data: runs, now } = await fetchedNow(listRuns({ sourceId: typeof sourceId === "string" ? sourceId : undefined }));
  const active = runs.some((r) => r.status === "queued" || r.status === "running");

  return (
    <>
      <AutoRefresh active={active} />
      {typeof sourceId === "string" && (
        <p className="text-sm">
          Showing one source.{" "}
          <Link href="/runs" className="underline">
            Show all
          </Link>
        </p>
      )}
      {runs.length === 0 ? (
        <p className="text-sm text-zinc-500">No runs yet. Start one from the Sources page.</p>
      ) : (
        <table className={tableClass}>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={thClass}>Source</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Started</th>
              <th className={thClass}>Took</th>
              <th className={`${thClass} text-right`}>Pages</th>
              <th className={`${thClass} text-right`}>New / seen</th>
              <th className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className={tdClass}>
                  <div className="font-medium">{r.sourceName}</div>
                  <div className="text-xs text-zinc-500">{r.trigger}</div>
                </td>
                <td className={tdClass}>
                  <StatusBadge status={r.status} />
                  {r.errorClass && (
                    <div className="mt-1 max-w-xs text-xs text-red-700 dark:text-red-400" title={r.errorMessage ?? undefined}>
                      {r.errorClass}: {r.errorMessage?.slice(0, 120)}
                    </div>
                  )}
                </td>
                <td className={`${tdClass} text-xs text-zinc-500`}>{timeAgo(r.startedAt ?? r.createdAt, now)}</td>
                <td className={`${tdClass} text-xs tabular-nums`}>{duration(r.startedAt, r.finishedAt, now)}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{r.pages}</td>
                <td className={`${tdClass} text-right tabular-nums`}>
                  {r.itemsNew.toLocaleString("en-GB")} / {r.itemsFound.toLocaleString("en-GB")}
                </td>
                <td className={`${tdClass} text-right`}>
                  {(r.status === "queued" || r.status === "running") && (
                    <form action={cancelRunAction}>
                      <input type="hidden" name="runId" value={r.id} />
                      <button type="submit" className={buttonClass}>
                        Cancel
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
