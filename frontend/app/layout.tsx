import "@near-wallet-selector/modal-ui/styles.css";
import "./globals.css";
import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { WalletProvider } from "@/lib/wallet";

export const metadata: Metadata = {
  title: "PayGuard · on-chain spending rules for AI agents on NEAR",
  description: "Let an AI agent request payments it can't push past your on-chain rules: per-payment caps, daily limits, allowlisted recipients, a guardian with 24h vetoes and an emergency sweep to a fixed exit account.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <WalletProvider><Shell>{children}</Shell></WalletProvider>
      </body>
    </html>
  );
}
