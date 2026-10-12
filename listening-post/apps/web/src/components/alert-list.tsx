import Link from "next/link";
import { timeAgo } from "@/components/ui";
import type { Alert } from "@/lib/api";

/** Plain words for each alert kind; the message carries the details. */
const KIND_LABELS: Record<string, string> = {
  run_failed: "Run failed",
  layout_changed: "Layout changed",
  quota: "Out of credits",
  budget: "Budget nearly used",
  escalated: "Needed a paid step",
  zero_items: "Empty listings",
  volume_drop: "Volume dropped",
  field_coverage: "Fewer countries",
  stale: "No recent run",
  host_down: "Site unreachable",
};

/** Open alerts, each with a warning mark and a word, never colour alone. */
export function AlertList({ alerts, now, showSource = true }: { alerts: Alert[]; now: number; showSource?: boolean }) {
  if (alerts.length === 0) return <p className="text-sm text-zinc-500">No open alerts.</p>;
  return (
    <ul className="space-y-3 text-sm">
      {alerts.map((a) => (
        <li key={a.id} className="flex gap-2">
          <span aria-hidden className="mt-0.5 text-amber-600 dark:text-amber-400">
            ▲
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{KIND_LABELS[a.kind] ?? a.kind}</span>
              {showSource &&
                (a.sourceId ? (
                  <Link href={`/sources/${a.sourceId}`} className="hover:underline">
                    {a.sourceName}
                  </Link>
                ) : (
                  <span className="text-zinc-500">all sources</span>
                ))}
              <span className="text-xs text-zinc-500">since {timeAgo(a.openedAt, now)}</span>
            </div>
            <p className="mt-0.5 break-words text-xs text-zinc-600 dark:text-zinc-400">{a.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
