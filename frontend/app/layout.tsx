import "./globals.css";
import type { Metadata } from "next";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Payguard · spending guard for AI agents on NEAR",
  description: "Give an AI agent a wallet it can't drain: per-payment caps, daily limits, allowlisted recipients, a guardian with 24h vetoes and a one-tap emergency sweep.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
