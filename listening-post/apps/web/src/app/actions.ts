"use server";

import { refresh } from "next/cache";
import { ApiError, cancelRun, runSource } from "@/lib/api";

const UUID = /^[0-9a-f-]{36}$/i;

/** "Run now" on a source. A run already queued or running for it is not an error; the new one waits its turn. */
export async function runSourceAction(formData: FormData): Promise<void> {
  const id = String(formData.get("sourceId") ?? "");
  if (!UUID.test(id)) return;
  await runSource(id);
  refresh();
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
