import Link from "next/link";
import { cancelRunAction } from "@/app/actions";
import { StatusBadge, buttonClass, duration, num, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import type { Run } from "@/lib/api";

/** Run history, newest first, with a Cancel button on active runs. */
export function RunsTable({ runs, now, showSource = true }: { runs: Run[]; now: number; showSource?: boolean }) {
  if (runs.length === 0) return <p className="text-sm text-zinc-500">No runs yet.</p>;
  return (
    <table className={tableClass}>
      <thead className="border-b border-zinc-200 dark:border-zinc-800">
        <tr>
          {showSource && <th className={thClass}>Source</th>}
          <th className={thClass}>Status</th>
          <th className={thClass}>Started</th>
          <th className={thClass}>Took</th>
          <th className={`${thClass} text-right`}>Requests</th>
          <th className={`${thClass} text-right`}>New / seen</th>
          <th className={thClass}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {runs.map((r) => (
          <tr key={r.id}>
            {showSource && (
              <td className={tdClass}>
                <Link href={`/sources/${r.sourceId}`} className="font-medium hover:underline">
                  {r.sourceName}
                </Link>
                <div className="text-xs text-zinc-500">{r.trigger}</div>
              </td>
            )}
            <td className={tdClass}>
              <Link href={`/runs/${r.id}`} className="hover:underline">
                <StatusBadge status={r.status} />
              </Link>
              {r.errorClass && (
                <div className="mt-1 max-w-xs text-xs text-red-700 dark:text-red-400" title={r.errorMessage ?? undefined}>
                  {r.errorClass}: {r.errorMessage?.slice(0, 120)}
                </div>
              )}
            </td>
            <td className={`${tdClass} text-xs text-zinc-500`}>
              {timeAgo(r.startedAt ?? r.createdAt, now)}
              {!showSource && <div>{r.trigger}</div>}
            </td>
            <td className={`${tdClass} text-xs tabular-nums`}>{duration(r.startedAt, r.finishedAt, now)}</td>
            <td className={`${tdClass} text-right tabular-nums`}>{num(r.requests)}</td>
            <td className={`${tdClass} text-right tabular-nums`}>
              {num(r.itemsNew)} / {num(r.itemsFound)}
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
  );
}
