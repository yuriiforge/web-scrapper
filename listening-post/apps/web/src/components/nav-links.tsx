"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/login/actions";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/sources", label: "Sources" },
  { href: "/runs", label: "Runs" },
  { href: "/items", label: "Items" },
  { href: "/costs", label: "Costs" },
  { href: "/insights", label: "Insights" },
];

/** Top navigation; the current section is marked for screen readers and by weight, not colour alone. */
export function NavList({ path }: { path: string | null }) {
  const current = (href: string) => path !== null && (href === "/" ? path === "/" : path.startsWith(href));
  // Signed-out pages show only the name: no links that would bounce back to login, and no "Sign out".
  if (path === "/login") {
    return (
      <nav className="mx-auto flex max-w-6xl items-center text-sm">
        <span className="text-base font-semibold">Listening Post</span>
      </nav>
    );
  }
  return (
    <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <Link href="/" className="mr-3 text-base font-semibold">
        Listening Post
      </Link>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={current(l.href) ? "page" : undefined}
          className={
            current(l.href)
              ? "font-semibold text-zinc-950 underline decoration-2 underline-offset-8 dark:text-white"
              : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          }
        >
          {l.label}
        </Link>
      ))}
      <form action={logoutAction} className="ml-auto">
        <button type="submit" className="text-zinc-500 hover:text-zinc-950 dark:hover:text-white">
          Sign out
        </button>
      </form>
    </nav>
  );
}

/** Reads the current path, which is request-time data: render it inside <Suspense>. */
export function NavLinks() {
  return <NavList path={usePathname()} />;
}
