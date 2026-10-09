"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface LineSeries {
  key: string;
  label: string;
  /** A CSS colour, normally a --viz-* token. */
  color: string;
  values: number[];
}

const H = 260;
/** Minimum gap between direct labels at line ends; closer than this, the legend carries identity instead. */
const LABEL_GAP = 14;
const PAD = { top: 12, right: 88, bottom: 28, left: 48 };

/** Round, readable tick steps: 1, 2, 5 x 10^n. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step);
  return ticks;
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Multi-series line chart over days, with a hover crosshair, tooltip, legend, direct labels and a table view. */
export function LineChart({ title, days, series, unit = "items" }: { title: string; days: string[]; series: LineSeries[]; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  // Drawn at the container's real width, so text keeps its size instead of scaling with the page.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(320, Math.round(entry.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const { ticks, x, y } = useMemo(() => {
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const t = niceTicks(max);
    const top = t.at(-1)!;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    return {
      ticks: t,
      x: (i: number) => PAD.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW),
      y: (v: number) => PAD.top + plotH - (v / top) * plotH,
    };
  }, [days.length, series, W]);

  if (days.length === 0 || series.length === 0) {
    return <p className="text-sm text-zinc-500">No items in this period.</p>;
  }

  const xLabelEvery = Math.max(1, Math.ceil(days.length / Math.max(3, Math.floor(W / 110))));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const step = (W - PAD.left - PAD.right) / Math.max(1, days.length - 1);
    setHover(Math.min(days.length - 1, Math.max(0, Math.round((px - PAD.left) / step))));
  };

  // Direct labels at line ends, only when every pair of ends is far enough apart. Nudging
  // converging labels would detach them from their lines, so the legend carries identity then.
  const ends = series.map((s) => ({ s, y: y(s.values.at(-1) ?? 0) })).sort((a, b) => a.y - b.y);
  const showEndLabels = ends.every((e, i) => i === 0 || e.y - ends[i - 1]!.y >= LABEL_GAP);

  return (
    <figure className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption id={titleId} className="text-sm font-medium">
          {title}
        </figcaption>
        {series.length >= 2 && (
          <ul className="flex gap-4 text-xs text-zinc-600 dark:text-zinc-400" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative" ref={box}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block max-w-full select-none"
          role="img"
          aria-label={`${title}. Use the table below for exact values.`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={12} fill="var(--viz-muted)" className="tabular-nums">
                {t.toLocaleString("en-GB")}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
          {days.map((d, i) =>
            i % xLabelEvery === 0 || i === days.length - 1 ? (
              <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--viz-muted)">
                {shortDate(d)}
              </text>
            ) : null,
          )}
          {series.map((s) => (
            <polyline
              key={s.key}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {showEndLabels &&
            ends.map(({ s, y: ly }) => (
            <g key={s.key}>
              <line x1={x(days.length - 1) + 4} x2={x(days.length - 1) + 12} y1={ly} y2={ly} stroke={s.color} strokeWidth={2} />
              <text x={x(days.length - 1) + 16} y={ly + 4} fontSize={12} fill="var(--viz-ink-2)">
                {s.label}
              </text>
            </g>
          ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--viz-surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-white/10 dark:bg-zinc-900"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > days.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            <div className="font-medium">{shortDate(days[hover]!)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 tabular-nums">
                <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-zinc-600 dark:text-zinc-400">{s.label}</span>
                <span className="ml-auto pl-3">
                  {(s.values[hover] ?? 0).toLocaleString("en-GB")} {unit}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-500">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-1 pr-4 font-medium">Day</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 pr-4 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 pr-4">{d}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 pr-4 text-right">
                      {(s.values[i] ?? 0).toLocaleString("en-GB")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
