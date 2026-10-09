"use client";

import { useId, useState } from "react";

export interface Bar {
  key: string;
  label: string;
  /** Second line under the label, e.g. the client. */
  sublabel?: string;
  value: number;
}

/**
 * Horizontal bars for one measure across items: thin (20px), rounded at the data end and square
 * at the baseline, each value labelled at the bar end. One series, so one colour and no legend.
 */
export function BarList({ title, bars, unit = "items", color = "var(--viz-seq)" }: { title: string; bars: Bar[]; unit?: string; color?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();
  const max = Math.max(1, ...bars.map((b) => b.value));
  const total = bars.reduce((n, b) => n + b.value, 0);

  if (bars.length === 0) return <p className="text-sm text-zinc-500">No items in this period.</p>;

  return (
    <figure className="space-y-3" aria-labelledby={titleId}>
      <figcaption id={titleId} className="text-sm font-medium">
        {title}
      </figcaption>
      <ul className="space-y-1.5">
        {bars.map((b) => {
          const share = total > 0 ? (b.value / total) * 100 : 0;
          return (
            <li
              key={b.key}
              className={`relative grid grid-cols-[minmax(7rem,12rem)_1fr] items-center gap-3 rounded px-1 py-0.5 ${hover === b.key ? "bg-zinc-100 dark:bg-zinc-800/60" : ""}`}
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="min-w-0 text-xs">
                <div className="truncate" title={b.label}>
                  {b.label}
                </div>
                {b.sublabel && <div className="truncate text-zinc-500">{b.sublabel}</div>}
              </div>
              <div className="flex items-center gap-2">
                <div
                  aria-hidden
                  className="h-5 rounded-r"
                  style={{ width: `${Math.max(0.5, (b.value / max) * 85)}%`, background: color }}
                />
                <span className="text-xs tabular-nums text-zinc-700 dark:text-zinc-300">{b.value.toLocaleString("en-GB")}</span>
              </div>
              {hover === b.key && (
                <div
                  role="status"
                  className="pointer-events-none absolute right-1 -top-7 z-10 rounded-md border border-black/10 bg-white px-2 py-1 text-xs shadow-sm dark:border-white/10 dark:bg-zinc-900"
                >
                  {b.label}: {b.value.toLocaleString("en-GB")} {unit} · {share.toFixed(1)}% of total
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-500">Show as table</summary>
        <table className="mt-2 w-full tabular-nums">
          <tbody>
            {bars.map((b) => (
              <tr key={b.key} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-4">{b.label}</td>
                <td className="py-1 pr-4 text-right">{b.value.toLocaleString("en-GB")}</td>
                <td className="py-1 text-right text-zinc-500">{total > 0 ? ((b.value / total) * 100).toFixed(1) : "0.0"}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
