"use client";

import { useActionState, useState } from "react";
import { saveSourceAction, type SourceFormState } from "@/app/actions";
import { inputClass, primaryButtonClass } from "@/components/ui";
import type { Client, SourceDetail } from "@/lib/api";

const AGORA_CATEGORIES = ["electric-cars", "budget-airlines", "meal-kits", "fitness-trackers", "online-banks"];
const THREADIT_COMMUNITIES = ["gb", "de", "fr", "us", "pl", "ua", "electric_cars", "budget_airlines", "meal_kits", "fitness_trackers", "online_banks"];
const RATEWELL_COMPANIES = [
  "voltra-motors", "ampwick-auto", "silvane-ev", "kestrel-drive", "northcoil-cars", "brindle-electric", "zephyrine-motors", "ohmsted-auto",
  "skypenny-air", "lowcloud-airways", "fairwing", "jetsparrow", "cirrusaver", "hopwell-air", "tailbreeze", "bluestep-airlines",
  "pantrybox", "forkfold", "simmerly", "crate-ladle", "hearthkit", "greenparcel", "spoonward", "dinnerloft",
  "pulseroo", "stridewell", "heartlap", "pacewren", "vitaloop", "trekmark", "cadenza-fit", "moxie-band",
  "coinharbor", "ledgerly", "brightvault", "pennyfox-bank", "quillbank", "mintora", "hollow-oak-bank", "tallycap",
];
const RATEWELL_STEPS = [
  { value: "html", label: "Plain HTTP", hint: "free; reimplements the page's token" },
  { value: "browser", label: "Browser (Playwright)", hint: "about $0.01 a minute" },
  { value: "unblocker", label: "PassGate unblocker", hint: "1 credit a page, 5 for a rendered page" },
];
const SITE_NAMES: Record<string, string> = { threadit: "Threadit", agora: "Agora", ratewell: "Ratewell" };

/** Create or edit a source. Site-specific config fields change with the site; the API has the final say on validity. */
export function SourceForm({ clients, source }: { clients: Client[]; source?: SourceDetail }) {
  const [state, action, pending] = useActionState<SourceFormState, FormData>(saveSourceAction, {});
  const [site, setSite] = useState<string>(source?.site ?? "threadit");
  const cfg = (source?.config ?? {}) as Record<string, string | number | boolean | undefined>;
  const errorFor = (...names: string[]) =>
    state.field && names.some((n) => state.field === n || state.field === `config.${n}`) ? (
      <p className="mt-1 text-xs text-red-700 dark:text-red-400">{state.error}</p>
    ) : null;
  const value = (k: string) => (cfg[k] === undefined ? undefined : String(cfg[k]));
  const steps = Array.isArray(source?.config.strategies) ? (source.config.strategies as string[]) : RATEWELL_STEPS.map((s) => s.value);

  return (
    <form action={action} className="max-w-xl space-y-5">
      {source && <input type="hidden" name="id" value={source.id} />}
      <input type="hidden" name="site" value={site} />

      {!source && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" htmlFor="clientId">
            <select id="clientId" name="clientId" className={inputClass} required>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errorFor("clientId")}
          </Field>
          <Field label="Site" htmlFor="siteSelect">
            <select id="siteSelect" className={inputClass} value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="threadit">Threadit (official API)</option>
              <option value="agora">Agora (forum)</option>
              <option value="ratewell">Ratewell (reviews, bot-protected)</option>
            </select>
          </Field>
        </div>
      )}

      <Field label="Name" htmlFor="name">
        <input id="name" name="name" className={inputClass} defaultValue={source?.name} placeholder="Threadit · gb" required />
        {errorFor("name")}
      </Field>

      <fieldset className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{SITE_NAMES[site] ?? site} settings</legend>
        {site === "threadit" ? (
          <>
            <Field label="Community" htmlFor="community" hint="A country (gb, de, …) or a topic (meal_kits, …)">
              <input id="community" name="community" list="communities" className={inputClass} defaultValue={value("community")} required />
              <datalist id="communities">
                {THREADIT_COMMUNITIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {errorFor("community")}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Page size" htmlFor="pageSize">
                <input id="pageSize" name="pageSize" type="number" min={1} max={100} className={inputClass} defaultValue={value("pageSize") ?? "100"} />
                {errorFor("pageSize")}
              </Field>
              <Field label="Max pages" htmlFor="maxPages" hint="Empty: no limit">
                <input id="maxPages" name="maxPages" type="number" min={1} className={inputClass} defaultValue={value("maxPages")} />
                {errorFor("maxPages")}
              </Field>
              <Field label="Requests / min" htmlFor="ratePerMinute" hint="Default 50">
                <input id="ratePerMinute" name="ratePerMinute" type="number" min={1} className={inputClass} defaultValue={value("ratePerMinute")} />
                {errorFor("ratePerMinute")}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="includeComments" defaultChecked={cfg.includeComments !== false} />
              Collect comments of new posts
            </label>
          </>
        ) : site === "ratewell" ? (
          <>
            <Field label="Company" htmlFor="company" hint="The company's slug on Ratewell, e.g. voltra-motors">
              <input id="company" name="company" list="companies" className={inputClass} defaultValue={value("company")} required />
              <datalist id="companies">
                {RATEWELL_COMPANIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {errorFor("company")}
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Allowed steps (cheapest first)</legend>
              <div className="space-y-1 text-sm">
                {RATEWELL_STEPS.map((s) => (
                  <label key={s.value} className="flex items-start gap-2">
                    <input type="checkbox" name={`step_${s.value}`} defaultChecked={steps.includes(s.value)} className="mt-1" />
                    <span>
                      {s.label} <span className="text-xs text-zinc-500">{s.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {errorFor("strategies")}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max pages" htmlFor="maxPages" hint="20 reviews a page; empty: no limit">
                <input id="maxPages" name="maxPages" type="number" min={1} className={inputClass} defaultValue={value("maxPages")} />
                {errorFor("maxPages")}
              </Field>
              <Field label="Requests / min" htmlFor="ratePerMinute" hint="Default 20; above 30 the site blocks for 5 min">
                <input id="ratePerMinute" name="ratePerMinute" type="number" min={1} className={inputClass} defaultValue={value("ratePerMinute")} />
                {errorFor("ratePerMinute")}
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" htmlFor="category" hint="Empty: every category">
                <select id="category" name="category" className={inputClass} defaultValue={value("category") ?? ""}>
                  <option value="">All categories</option>
                  {AGORA_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {errorFor("category")}
              </Field>
              <Field label="Format" htmlFor="format">
                <select id="format" name="format" className={inputClass} defaultValue={value("format") ?? "json"}>
                  <option value="json">Hidden JSON endpoints</option>
                  <option value="html">HTML pages</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max topics per run" htmlFor="maxTopics" hint="Empty: no limit">
                <input id="maxTopics" name="maxTopics" type="number" min={1} className={inputClass} defaultValue={value("maxTopics")} />
                {errorFor("maxTopics")}
              </Field>
              <Field label="Requests / min" htmlFor="ratePerMinute" hint="At most 60; robots.txt still applies">
                <input id="ratePerMinute" name="ratePerMinute" type="number" min={1} max={60} className={inputClass} defaultValue={value("ratePerMinute")} />
                {errorFor("ratePerMinute")}
              </Field>
            </div>
          </>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Schedule (cron, UTC)" htmlFor="schedule" hint='e.g. "*/15 * * * *"; empty: manual only'>
          <input id="schedule" name="schedule" className={`${inputClass} font-mono`} defaultValue={source?.schedule ?? ""} placeholder="*/15 * * * *" />
          {errorFor("schedule")}
        </Field>
        <Field label="Monthly budget (USD)" htmlFor="budgetUsdMonth" hint="Empty: no budget">
          <input id="budgetUsdMonth" name="budgetUsdMonth" type="number" min={0} step="0.01" className={inputClass} defaultValue={source?.budgetUsdMonth ?? ""} />
          {errorFor("budgetUsdMonth")}
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={source?.enabled ?? true} />
        Enabled (scheduled runs happen only while enabled)
      </label>

      {state.error && !state.field && <p className="text-sm text-red-700 dark:text-red-400">{state.error}</p>}
      {state.error && state.field && (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          Please fix the highlighted field ({state.field}).
        </p>
      )}

      <button type="submit" className={primaryButtonClass} disabled={pending}>
        {pending ? "Saving…" : source ? "Save changes" : "Create source"}
      </button>
    </form>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}
