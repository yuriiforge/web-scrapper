import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SourceForm } from "@/components/source-form";
import { PageHeader } from "@/components/ui";
import { ApiError, getSource, listClients } from "@/lib/api";

export default function EditSourcePage({ params }: PageProps<"/sources/[id]/edit">) {
  return (
    <div className="space-y-6">
      <PageHeader title="Edit source" description="The site and client of a source cannot change; create a new source for that." />
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <EditForm params={params} />
      </Suspense>
    </div>
  );
}

async function load(id: string) {
  try {
    return await Promise.all([getSource(id), listClients()]);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
}

async function EditForm({ params }: { params: PageProps<"/sources/[id]/edit">["params"] }) {
  const { id } = await params;
  const [source, clients] = await load(id);
  return <SourceForm clients={clients} source={source} />;
}
