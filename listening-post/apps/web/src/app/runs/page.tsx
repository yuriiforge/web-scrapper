import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { RunsTable } from "@/components/runs-table";
import { PageHeader } from "@/components/ui";
import { fetchedNow, listRuns } from "@/lib/api";

export default function RunsPage({ searchParams }: PageProps<"/runs">) {
  return (
    <div className="space-y-4">
      <PageHeader title="Runs" description="Newest first. Updates every 3 seconds while a run is active." />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading runs…</p>}>
        <RunsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function RunsBody({ searchParams }: { searchParams: PageProps<"/runs">["searchParams"] }) {
  const { sourceId } = await searchParams;
  const one = typeof sourceId === "string" ? sourceId : undefined;
  const { data: runs, now } = await fetchedNow(listRuns({ sourceId: one, limit: 100 }));
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  return (
    <>
      <AutoRefresh active={active} />
      {one && (
        <p className="text-sm">
          Showing one source.{" "}
          <Link href="/runs" className="underline">
            Show all
          </Link>
        </p>
      )}
      <RunsTable runs={runs} now={now} />
    </>
  );
}
