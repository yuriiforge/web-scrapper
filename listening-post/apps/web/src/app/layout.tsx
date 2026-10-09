import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listening Post",
  description: "Collection runs, sources, costs and sentiment.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <span className="text-lg font-semibold">Listening Post</span>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
