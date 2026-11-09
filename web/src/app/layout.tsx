import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import "@xyflow/react/dist/style.css";
import { Header } from "@/components/Header";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const schibsted = Schibsted_Grotesk({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-schibsted" });

export const metadata: Metadata = {
  title: "orch",
  description: "Give orch a goal. It drafts a plan, you choose who plays each part, and you watch it play out.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={schibsted.variable}>
      <body className="flex h-full flex-col">
        <SessionProvider>
          <Header />
          <main className="min-h-0 flex-1 border-t border-rule">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
