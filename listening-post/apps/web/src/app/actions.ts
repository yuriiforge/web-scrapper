"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, cancelRun, createSource, deleteSource, reparseSource, runEvaluation, runSource, updateSource } from "@/lib/api";

const UUID = /^[0-9a-f-]{36}$/i;

/** "Run now" on a source. A run already queued or running for it is not an error; the new one waits its turn. */
export async function runSourceAction(formData: FormData): Promise<void> {
  const id = String(formData.get("sourceId") ?? "");
  if (!UUID.test(id)) return;
  await runSource(id);
  refresh();
}

/** Re-runs the parser over stored raw responses, with no new requests. */
export async function reparseSourceAction(formData: FormData): Promise<void> {
  const id = String(formData.get("sourceId") ?? "");
  if (!UUID.test(id)) return;
  await reparseSource(id);
  refresh();
}

/** Checks one scorer against ground truth. A method with no scores yet, or truth that cannot be reached, comes back as a message. */
export async function runEvaluationAction(formData: FormData): Promise<void> {
  const method = formData.get("method") === "llm" ? "llm" : "rules";
  const days = String(formData.get("days") ?? "30").replace(/D/g, "") || "30";
  try {
    await runEvaluation(method, 500);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 422 || err.status === 502)) {
      redirect(`/insights?days=${days}&evalError=${encodeURIComponent(err.detail ?? err.code)}#scoring`);
    }
    throw err;
  }
  // Same URL apart from the hash, which alone would only scroll: refresh so the new result renders.
  refresh();
  redirect(`/insights?days=${days}#scoring`);
}

export async function cancelRunAction(formData: FormData): Promise<void> {
  const id = String(formData.get("runId") ?? "");
  if (!UUID.test(id)) return;
  try {
    await cancelRun(id);
  } catch (err) {
    // Already finished between page load and click: nothing to cancel.
    if (!(err instanceof ApiError && err.code === "not_cancellable")) throw err;
  }
  refresh();
}

export async function setSourceEnabledAction(formData: FormData): Promise<void> {
  const id = String(formData.get("sourceId") ?? "");
  if (!UUID.test(id)) return;
  await updateSource(id, { enabled: formData.get("enabled") === "true" });
  refresh();
}

export async function deleteSourceAction(formData: FormData): Promise<void> {
  const id = String(formData.get("sourceId") ?? "");
  if (!UUID.test(id)) return;
  await deleteSource(id);
  redirect("/sources");
}

export interface SourceFormState {
  error?: string;
  field?: string;
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const optionalInt = (f: FormData, k: string) => {
  const v = text(f, k);
  return v === "" ? undefined : Number(v);
};

/** Builds the site-specific config from the form; the API validates it. */
function configFrom(site: string, f: FormData): Record<string, unknown> {
  if (site === "threadit") {
    return {
      community: text(f, "community"),
      pageSize: optionalInt(f, "pageSize") ?? 100,
      includeComments: f.get("includeComments") === "on",
      maxPages: optionalInt(f, "maxPages"),
      ratePerMinute: optionalInt(f, "ratePerMinute"),
    };
  }
  if (site === "chirp") {
    return {
      query: text(f, "query"),
      country: text(f, "country") || undefined,
      maxResults: optionalInt(f, "maxResults"),
      maxPostsPerRun: optionalInt(f, "maxPostsPerRun"),
      backfillDays: optionalInt(f, "backfillDays"),
      ratePerMinute: optionalInt(f, "ratePerMinute"),
    };
  }
  if (site === "ratewell") {
    return {
      company: text(f, "company"),
      strategies: ["html", "browser", "unblocker"].filter((s) => f.get(`step_${s}`) === "on"),
      maxPages: optionalInt(f, "maxPages"),
      ratePerMinute: optionalInt(f, "ratePerMinute"),
    };
  }
  return {
    category: text(f, "category") || undefined,
    format: text(f, "format") || "json",
    maxTopics: optionalInt(f, "maxTopics"),
    ratePerMinute: optionalInt(f, "ratePerMinute"),
  };
}

/** Creates or updates a source. Returns the API's validation error to show next to the field. */
export async function saveSourceAction(_prev: SourceFormState, f: FormData): Promise<SourceFormState> {
  const id = text(f, "id");
  const site = text(f, "site");
  const budget = text(f, "budgetUsdMonth");
  const common = {
    name: text(f, "name"),
    schedule: text(f, "schedule") || null,
    enabled: f.get("enabled") === "on",
    budgetUsdMonth: budget === "" ? null : Number(budget),
    config: configFrom(site, f),
  };

  let savedId: string;
  try {
    const saved = id ? await updateSource(id, common) : await createSource({ ...common, clientId: text(f, "clientId"), site });
    savedId = saved.id;
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      return { error: err.detail ?? (err.code === "conflict" ? "Already exists" : "Invalid value"), field: err.field };
    }
    throw err;
  }
  redirect(`/sources/${savedId}`);
}
