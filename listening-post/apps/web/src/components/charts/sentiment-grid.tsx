import type { SentimentGrid as Grid } from "@/lib/api";

const MIN_RELIABLE = 20;

/**
 * Country x category heatmap of net sentiment (share positive minus share negative), on a
 * diverging blue/red scale with a grey midpoint. Every cell prints its value and count, so
 * colour never carries meaning alone; cells with few items are marked as unreliable.
 */
export function SentimentGrid({ grid }: { grid: Grid }) {
  if (grid.scoredItems === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">No sentiment scores yet.</p>
        <p className="mt-1">
          The worker scores new items within a minute of collection; this grid fills in as soon as scores exist in the period.
        </p>
      </div>
    );
  }

  const countries = [...new Set(grid.cells.map((c) => c.country ?? "—"))].sort();
  const cell = (country: string, category: string) => grid.cells.find((c) => (c.country ?? "—") === country && c.category === category);
  const fill = (net: number) =>
    `color-mix(in oklab, ${net >= 0 ? "var(--viz-pos)" : "var(--viz-neg)"} ${Math.round(Math.min(1, Math.abs(net)) * 85)}%, var(--viz-mid))`;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="text-xs tabular-nums">
          <thead>
            <tr>
              <th className="p-1 text-left font-medium text-zinc-500">Country</th>
              {grid.categories.map((c) => (
                <th key={c} className="p-1 text-center font-medium text-zinc-500">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {countries.map((country) => (
              <tr key={country}>
                <th className="p-1 text-left font-medium">{country}</th>
                {grid.categories.map((category) => {
                  const c = cell(country, category);
                  return (
                    <td key={category} className="p-0.5">
                      {c ? (
                        <div
                          className={`w-24 rounded px-2 py-1.5 text-center text-zinc-900 dark:text-white ${c.n < MIN_RELIABLE ? "opacity-60" : ""}`}
                          style={{ background: fill(c.net) }}
                          title={`${country} · ${category}: ${c.positive} positive, ${c.negative} negative of ${c.n}`}
                        >
                          {c.net >= 0 ? "+" : ""}
                          {Math.round(c.net * 100)}
                          <span className="ml-1 text-[10px] opacity-80">n={c.n}</span>
                        </div>
                      ) : (
                        <div className="w-24 px-2 py-1.5 text-center text-zinc-400">–</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        Net sentiment in points: % positive minus % negative. Faded cells have fewer than {MIN_RELIABLE} items. {grid.scoredItems.toLocaleString("en-GB")}{" "}
        scored items, {grid.llmScoredItems.toLocaleString("en-GB")} of them labelled by Claude and the rest by the rules baseline. Copies of a text count
        once.
      </p>
    </div>
  );
}
