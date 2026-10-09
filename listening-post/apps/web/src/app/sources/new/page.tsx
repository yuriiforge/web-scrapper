import { Suspense } from "react";
import { SourceForm } from "@/components/source-form";
import { PageHeader } from "@/components/ui";
import { listClients } from "@/lib/api";

export default function NewSourcePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Add source" description="Pick a client and a site, then what to collect and how often." />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <NewSourceForm />
      </Suspense>
    </div>
  );
}

async function NewSourceForm() {
  const clients = await listClients();
  if (clients.length === 0) return <p className="text-sm text-zinc-500">Create a client first (POST /api/clients).</p>;
  return <SourceForm clients={clients} />;
}
