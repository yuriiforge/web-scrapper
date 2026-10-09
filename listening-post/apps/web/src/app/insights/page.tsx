import { Suspense } from "react";
import { BarList } from "@/components/charts/bar-list";
import { LineChart } from "@/components/charts/line-chart";
import { SentimentGrid } from "@/components/charts/sentiment-grid";
import { Card, PageHeader, PeriodPicker, SITE_COLORS, SITE_LABELS, daysParam, num } from "@/components/ui";
import { getCountries, getSentiment, getSourceVolume, getVolume } from "@/lib/api";

export default function InsightsPage({ searchParams }: PageProps<"/insights">) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading insights…</p>}>
        <InsightsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function InsightsBody({ searchParams }: { searchParams: PageProps<"/insights">["searchParams"] }) {
  const days = daysParam((await searchParams).days);
  const [volume, countries, bySource, sentiment] = await Promise.all([getVolume(days), getCountries(days), getSourceVolume(days), getSentiment(days)]);
  const total = volume.series.reduce((n, s) => n + s.counts.reduce((a, b) => a + b, 0), 0);
  const withCountry = countries.countries.filter((c) => c.country !== null);
  const noCountry = countries.countries.find((c) => c.country === null)?.n ?? 0;

  return (
    <>
      <PageHeader
        title="Insights"
        description={`What people are talking about, by publish date. ${num(total)} items in the last ${days} days${volume.latestPublishedAt ? `; the newest was published ${new Date(volume.latestPublishedAt).toUTCString().slice(5, 22)} UTC` : ""}.`}
        actions={<PeriodPicker basePath="/insights" days={days} />}
      />

      <Card>
        <LineChart
          title="Conversations per day, by site"
          days={volume.days}
          series={volume.series.map((s) => ({ key: s.site, label: SITE_LABELS[s.site], color: SITE_COLORS[s.site], values: s.counts }))}
        />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <BarList
            title="Items by country"
            bars={withCountry.map((c) => ({ key: c.country!, label: c.country!, value: c.n }))}
          />
          <p className="mt-3 text-xs text-zinc-500">
            {num(noCountry)} more items have no country: forum posts, comments, and topic communities do not say where the author is. Their
            country can be inferred later, in step 7.
          </p>
        </Card>
        <Card>
          <BarList title="Items by source" bars={bySource.sources.map((s) => ({ key: s.sourceId, label: s.sourceName, sublabel: s.clientName, value: s.n }))} />
        </Card>
      </div>

      <Card title="Sentiment by country and category">
        <SentimentGrid grid={sentiment} />
      </Card>
    </>
  );
}
