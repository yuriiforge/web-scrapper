import Link from "next/link";
import { Suspense } from "react";
import { authEnabled } from "@/lib/session";
import { LoginForm } from "./login-form";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-zinc-500">Listening Post dashboard</p>
      </div>
      <Suspense fallback={<LoginForm next="/" />}>
        <WithNext searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function WithNext({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { next } = await searchParams;
  if (!authEnabled()) {
    return (
      <p className="text-sm">
        Login is turned off because ADMIN_PASSWORD is not set.{" "}
        <Link href="/" className="underline">
          Go to the dashboard
        </Link>
      </p>
    );
  }
  return <LoginForm next={typeof next === "string" ? next : "/"} />;
}
