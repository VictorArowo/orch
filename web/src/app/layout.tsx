import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import Link from "next/link";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const schibsted = Schibsted_Grotesk({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-schibsted" });

export const metadata: Metadata = {
  title: "orch",
  description: "Draft a tree of steps for a goal, cast roles and models, and watch it run.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={schibsted.variable}>
      <body className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-7 px-5">
          <Link href="/" className="text-[17px] font-bold tracking-tight text-ink">
            orch
          </Link>
          <nav className="flex gap-5 text-[14px] text-graphite">
            <Link href="/" className="hover:text-ink">
              New goal
            </Link>
            <Link href="/runs" className="hover:text-ink">
              Runs
            </Link>
          </nav>
        </header>
        <main className="min-h-0 flex-1 border-t border-rule">{children}</main>
      </body>
    </html>
  );
}
