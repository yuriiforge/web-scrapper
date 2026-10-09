import type { Metadata } from "next";
import { Suspense } from "react";
import { NavLinks, NavList } from "@/components/nav-links";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listening Post",
  description: "Collection runs, sources, costs and insights.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Suspense fallback={<NavList path={null} />}>
            <NavLinks />
          </Suspense>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
