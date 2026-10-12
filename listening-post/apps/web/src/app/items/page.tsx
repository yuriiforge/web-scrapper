import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, SiteLabel, buttonClass, inputClass, num, tableClass, tdClass, thClass, timeAgo } from "@/components/ui";
import { fetchedNow, listItems, listSources, type ItemFilters } from "@/lib/api";

const COUNTRIES = ["GB", "DE", "FR", "US", "PL", "UA"];
const one = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);

export default function ItemsPage({ searchParams }: PageProps<"/items">) {
  return (
    <div className="space-y-4">
      <PageHeader title="Items" description="Everything collected, newest first by publish date. Text is shown as stored: normalised, tags removed." />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading items…</p>}>
        <ItemsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ItemsBody({ searchParams }: { searchParams: PageProps<"/items">["searchParams"] }) {
  const sp = await searchParams;
  const filters: ItemFilters = { site: one(sp.site), sourceId: one(sp.sourceId), country: one(sp.country), q: one(sp.q), cursor: one(sp.cursor) };
  const [{ data, now }, sources] = await Promise.all([fetchedNow(listItems(filters)), listSources()]);
  const { cursor, ...withoutCursor } = filters;
  const link = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...withoutCursor, ...extra })) if (v) q.set(k, v);
    return `/items?${q}`;
  };
  const filtered = Object.values(withoutCursor).some(Boolean);

  return (
    <>
      <form method="get" action="/items" className="grid gap-2 rounded-lg border border-zinc-200 bg-white p-3 sm:grid-cols-[1fr_auto_auto_auto_auto] dark:border-zinc-800 dark:bg-zinc-900">
        <label className="sr-only" htmlFor="q">
          Search text
        </label>
        <input id="q" name="q" defaultValue={filters.q} placeholder="Search text…" className={inputClass} />
        <label className="sr-only" htmlFor="site">
          Site
        </label>
        <select id="site" name="site" defaultValue={filters.site ?? ""} className={inputClass}>
          <option value="">All sites</option>
          <option value="threadit">Threadit</option>
          <option value="agora">Agora</option>
          <option value="ratewell">Ratewell</option>
        </select>
        <label className="sr-only" htmlFor="sourceId">
          Source
        </label>
        <select id="sourceId" name="sourceId" defaultValue={filters.sourceId ?? ""} className={inputClass}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="country">
          Country
        </label>
        <select id="country" name="country" defaultValue={filters.country ?? ""} className={inputClass}>
          <option value="">Any country</option>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="none">Not given</option>
        </select>
        <div className="flex gap-2">
          <button type="submit" className={buttonClass}>
            Filter
          </button>
          {filtered && (
            <Link href="/items" className={`${buttonClass} self-center`}>
              Clear
            </Link>
          )}
        </div>
      </form>

      {data.items.length === 0 ? (
        <p className="text-sm text-zinc-500">No items match.</p>
      ) : (
        <table className={tableClass}>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={thClass}>Text</th>
              <th className={thClass}>Source</th>
              <th className={thClass}>Country</th>
              <th className={thClass}>Published</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.items.map((item) => (
              <tr key={item.id}>
                <td className={`${tdClass} max-w-xl`}>
                  <p className="line-clamp-3 text-sm" title={item.text}>
                    {item.text || <span className="italic text-zinc-400">(empty)</span>}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {typeof item.meta.rating === "number" && (
                      <span className="mr-1" aria-label={`Rated ${item.meta.rating} out of 5`}>
                        <span aria-hidden>{"★".repeat(item.meta.rating)}{"☆".repeat(5 - item.meta.rating)}</span> ·
                      </span>
                    )}
                    {item.author ?? "unknown author"} · <span className="font-mono">{item.externalId}</span>
                  </p>
                </td>
                <td className={`${tdClass} text-xs`}>
                  <Link href={`/sources/${item.sourceId}`} className="hover:underline">
                    {item.sourceName}
                  </Link>
                  <div className="text-zinc-500">
                    <SiteLabel site={item.site} />
                  </div>
                </td>
                <td className={`${tdClass} text-xs`}>{item.country ?? <span className="text-zinc-400">–</span>}</td>
                <td className={`${tdClass} text-xs text-zinc-500`}>{timeAgo(item.publishedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="text-xs text-zinc-500">
          {num(data.items.length)} shown{cursor ? " (older page)" : ""}
        </span>
        <span className="flex gap-2">
          {cursor && (
            <Link href={link({})} className={buttonClass}>
              ← Newest
            </Link>
          )}
          {data.nextCursor && (
            <Link href={link({ cursor: data.nextCursor })} className={buttonClass}>
              Older →
            </Link>
          )}
        </span>
      </div>
    </>
  );
}
