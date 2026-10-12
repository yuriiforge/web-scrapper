import { runEvaluationAction } from "@/app/actions";
import { Card, StatTile, buttonClass, num, tableClass, tdClass, thClass, timeAgo, usd } from "@/components/ui";
import type { AnalysisStatus, Evaluation, ScoreMethod } from "@/lib/api";

const METHOD_LABELS: Record<ScoreMethod, string> = { rules: "Rules baseline", llm: "Claude" };
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const CLASS_GROUPS = [
  { label: "Category", key: "category", classes: ["price", "quality", "customer service", "reliability", "usability", "delivery"] },
  { label: "Sentiment", key: "sentiment", classes: ["negative", "neutral", "positive"] },
] as const;
const f1 = (n: number | undefined) => (n === undefined ? "–" : n.toFixed(2));

/** Scoring coverage, and each scorer's accuracy against mock-web's ground truth. */
export function ScoringPanel({
  status,
  evaluations,
  days,
  now,
  error,
}: {
  status: AnalysisStatus;
  evaluations: Evaluation[];
  days: number;
  now: number;
  error?: string;
}) {
  const latest = (m: ScoreMethod) => evaluations.find((e) => e.method === m);
  const methods: ScoreMethod[] = ["rules", "llm"];
  const shown = methods.map(latest).filter((e): e is Evaluation => e !== undefined);
  const modelOff = status.methods.llm.scored === 0 && status.llmSpendMonthUsd === 0;

  return (
    <section id="scoring" className="space-y-4">
      <h2 className="text-sm font-medium">Scoring</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Rules labels" value={num(status.methods.rules.scored)} detail={`of ${num(status.items)} items; free, every item`} />
        <StatTile
          label="Claude labels"
          value={modelOff ? "off" : num(status.methods.llm.scored)}
          detail={
            modelOff
              ? "set ANTHROPIC_API_KEY on the worker"
              : `${num(status.methods.llm.unlabelled)} left unlabelled · ${status.methods.llm.latestAt ? `last ${timeAgo(status.methods.llm.latestAt, now)}` : "none yet"}`
          }
        />
        <StatTile label="Copies" value={num(status.duplicates)} detail={`${num(status.crossSiteDuplicates)} of them across sites; scored once`} />
        <StatTile label="Model spend" value={usd(status.llmSpendMonthUsd, 3)} detail="this month, all clients" href="/costs" />
      </div>

      <Card title="Accuracy against ground truth">
        {error && (
          <p role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {error}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Scorer</th>
                <th className={`${thClass} text-right`}>Category</th>
                <th className={`${thClass} text-right`}>Sentiment</th>
                <th className={`${thClass} text-right`}>Macro F1</th>
                <th className={`${thClass} text-right`}>Sample</th>
                <th className={thClass}>Checked</th>
                <th className={thClass}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => {
                const e = latest(m);
                return (
                  <tr key={m} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className={`${tdClass} font-medium`}>{METHOD_LABELS[m]}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{e ? pct(e.categoryAccuracy) : "–"}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{e ? pct(e.sentimentAccuracy) : "–"}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{e ? `${f1(e.f1ByClass.macroF1.category)} / ${f1(e.f1ByClass.macroF1.sentiment)}` : "–"}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{e ? num(e.sampleSize) : "–"}</td>
                    <td className={`${tdClass} text-zinc-500`}>{e ? timeAgo(e.createdAt, now) : "never"}</td>
                    <td className={tdClass}>
                      <form action={runEvaluationAction}>
                        <input type="hidden" name="method" value={m} />
                        <input type="hidden" name="days" value={days} />
                        <button type="submit" className={buttonClass} disabled={status.methods[m].scored === 0}>
                          Evaluate
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Accuracy on a random sample of up to 500 labelled items, compared with the labels mock-web generated them from. Macro F1 is shown as
          category / sentiment. The rules&apos; word lists were tuned on this corpus, so their score is optimistic for new wording.
        </p>

        {shown.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-zinc-500">F1 per class</summary>
            <div className="mt-2 overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Class</th>
                    {shown.map((e) => (
                      <th key={e.id} className={`${thClass} text-right`}>
                        {METHOD_LABELS[e.method]}
                      </th>
                    ))}
                    <th className={`${thClass} text-right`}>In sample</th>
                  </tr>
                </thead>
                {CLASS_GROUPS.map((g) => (
                  <tbody key={g.key}>
                    <tr className="border-t border-zinc-200 dark:border-zinc-700">
                      <th scope="rowgroup" colSpan={shown.length + 2} className={`${thClass} pt-3`}>
                        {g.label}
                      </th>
                    </tr>
                    {g.classes.map((c) => (
                      <tr key={c} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className={tdClass}>{c}</td>
                        {shown.map((e) => (
                          <td key={e.id} className={`${tdClass} text-right tabular-nums`}>
                            {f1(e.f1ByClass[g.key][c]?.f1)}
                          </td>
                        ))}
                        <td className={`${tdClass} text-right tabular-nums text-zinc-500`}>
                          {shown.map((e) => e.f1ByClass[g.key][c]?.support ?? 0).join(" / ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </details>
        )}
      </Card>
    </section>
  );
}
