import Link from "next/link";
import { Suspense } from "react";
import { Card, PageHeader, PeriodPicker, SiteLabel, StatTile, daysParam, num, tableClass, tdClass, thClass, usd } from "@/components/ui";
import { getCosts } from "@/lib/api";

export default function CostsPage({ searchParams }: PageProps<"/costs">) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading costs…</p>}>
        <CostsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const perItem = (v: number | null) => (v === null ? "–" : usd(v, 4));

async function CostsBody({ searchParams }: { searchParams: PageProps<"/costs">["searchParams"] }) {
  const days = daysParam((await searchParams).days);
  const c = await getCosts(days);
  const totals = c.clients.reduce(
    (t, r) => ({ usd: t.usd + r.usd, requests: t.requests + r.requests, itemsNew: t.itemsNew + r.itemsNew, runs: t.runs + r.runs }),
    { usd: 0, requests: 0, itemsNew: 0, runs: 0 },
  );

  return (
    <>
      <PageHeader
        title="Costs"
        description="Spend and usage per client and source. Spend comes from the cost ledger (paid providers); requests and new items come from runs."
        actions={<PeriodPicker basePath="/costs" days={days} />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Spend" value={usd(totals.usd)} detail={`last ${days} days`} />
        <StatTile label="New items" value={num(totals.itemsNew)} />
        <StatTile label="Cost per new item" value={totals.itemsNew > 0 ? usd(totals.usd / totals.itemsNew, 4) : "–"} />
        <StatTile label="Requests" value={num(totals.requests)} detail={`${num(totals.runs)} runs`} />
      </div>

      {totals.usd === 0 && (
        <Card>
          <p className="text-sm">
            <strong>No paid usage in this period.</strong>{" "}
            <span className="text-zinc-600 dark:text-zinc-400">
              Threadit (official API), Agora (public pages) and Ratewell over plain HTTP cost nothing per request. Spend appears when
              Ratewell needs a browser (charged per minute) or the PassGate unblocker (per credit), and later for Chirp&apos;s metered
              API (step 5). Each charge is recorded per run, source and client.
            </span>
          </p>
        </Card>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium">By client</h2>
        <table className={tableClass}>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={thClass}>Client</th>
              <th className={`${thClass} text-right`}>Runs</th>
              <th className={`${thClass} text-right`}>Requests</th>
              <th className={`${thClass} text-right`}>New items</th>
              <th className={`${thClass} text-right`}>Spend</th>
              <th className={`${thClass} text-right`}>Per new item</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
            {c.clients.map((r) => (
              <tr key={r.clientId}>
                <td className={`${tdClass} font-medium`}>{r.clientName}</td>
                <td className={`${tdClass} text-right`}>{num(r.runs)}</td>
                <td className={`${tdClass} text-right`}>{num(r.requests)}</td>
                <td className={`${tdClass} text-right`}>{num(r.itemsNew)}</td>
                <td className={`${tdClass} text-right`}>
                  {usd(r.usd)}
                  {r.analysisUsd > 0 && <div className="text-xs text-zinc-500">incl. {usd(r.analysisUsd, 3)} scoring</div>}
                </td>
                <td className={`${tdClass} text-right`}>{perItem(r.usdPerNewItem)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium">By source</h2>
        <table className={tableClass}>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={thClass}>Source</th>
              <th className={thClass}>Client</th>
              <th className={`${thClass} text-right`}>Requests</th>
              <th className={`${thClass} text-right`}>New items</th>
              <th className={`${thClass} text-right`}>Spend</th>
              <th className={`${thClass} text-right`}>Budget / month</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
            {c.sources.map((r) => (
              <tr key={r.id}>
                <td className={tdClass}>
                  <Link href={`/sources/${r.id}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    <SiteLabel site={r.site} /> · {r.strategy}
                  </div>
                </td>
                <td className={`${tdClass} text-xs`}>{r.clientName}</td>
                <td className={`${tdClass} text-right`}>{num(r.requests)}</td>
                <td className={`${tdClass} text-right`}>{num(r.itemsNew)}</td>
                <td className={`${tdClass} text-right`}>{usd(r.usd)}</td>
                <td className={`${tdClass} text-right text-zinc-500`}>{r.budgetUsdMonth === null ? "none" : usd(r.budgetUsdMonth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-zinc-500">
          Requests count every HTTP attempt, including retries, 304s and token requests. They are recorded from this release on, so older runs show 0.
        </p>
      </div>

      {c.providers.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">By provider</h2>
          <table className={tableClass}>
            <thead className="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className={thClass}>Provider</th>
                <th className={`${thClass} text-right`}>Units</th>
                <th className={`${thClass} text-right`}>Spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
              {c.providers.map((p) => (
                <tr key={`${p.provider}-${p.unit}`}>
                  <td className={tdClass}>{p.provider}</td>
                  <td className={`${tdClass} text-right`}>
                    {num(p.units)} {p.unit}
                  </td>
                  <td className={`${tdClass} text-right`}>{usd(p.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
