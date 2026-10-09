import Link from "next/link";
import type { ReactNode } from "react";
import type { RunStatus, Site } from "@/lib/api";

const STATUS_STYLES: Record<RunStatus, string> = {
  queued: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

/** Status always carries its word, never colour alone. */
export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{status}</span>;
}

/** Fixed colour per site, so a site looks the same in every chart and filter. */
export const SITE_COLORS: Record<Site, string> = {
  threadit: "var(--viz-threadit)",
  agora: "var(--viz-agora)",
  ratewell: "var(--viz-ratewell)",
  chirp: "var(--viz-chirp)",
};

export const SITE_LABELS: Record<Site, string> = { threadit: "Threadit", agora: "Agora", ratewell: "Ratewell", chirp: "Chirp" };

export function SiteLabel({ site }: { site: Site }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: SITE_COLORS[site] }} />
      {SITE_LABELS[site]}
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className = "" }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-medium">{title}</h2>}
      {children}
    </section>
  );
}

/** A single headline number. Proportional figures, no chart. */
export function StatTile({ label, value, detail, href }: { label: string; value: ReactNode; detail?: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-1 text-xs text-zinc-500">{detail}</div>}
    </>
  );
  const cls = "block rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
  return href ? (
    <Link href={href} className={`${cls} hover:border-zinc-400 dark:hover:border-zinc-600`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Choose a period; the selected one is marked with a check and bold text, not colour alone. */
export function PeriodPicker({ basePath, days, options = [7, 30, 90] }: { basePath: string; days: number; options?: number[] }) {
  return (
    <nav aria-label="Period" className="flex gap-1 text-sm">
      {options.map((d) => (
        <Link
          key={d}
          href={`${basePath}?days=${d}`}
          aria-current={d === days ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 ${d === days ? "bg-zinc-200 font-semibold dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
        >
          {d === days && <span aria-hidden>✓ </span>}
          Last {d} days
        </Link>
      ))}
    </nav>
  );
}

/** Reads ?days= from search params, falling back to a default and clamping to the allowed options. */
export function daysParam(value: string | string[] | undefined, fallback = 30, allowed = [7, 30, 90]): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return allowed.includes(n) ? n : fallback;
}

/** "3 min ago", "2 h ago", or a date for anything older than a day. */
export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "–";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function duration(startIso: string | null, endIso: string | null, now: number): string {
  if (!startIso) return "–";
  const s = Math.round(((endIso ? Date.parse(endIso) : now) - Date.parse(startIso)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function usd(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) });
}

export const num = (n: number) => n.toLocaleString("en-GB");

export const tableClass =
  "w-full overflow-hidden rounded-lg border border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900";
export const thClass = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500";
export const tdClass = "px-3 py-2 align-top";
export const buttonClass =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";
export const primaryButtonClass =
  "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200";
export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950";
