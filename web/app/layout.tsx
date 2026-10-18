import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Suspense } from "react";
import { GraphLine, GraphLineFallback } from "@/components/graph-line";
import { Nav } from "@/components/nav";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description = "An AI agent that traces a contaminated food ingredient lot to every store on a FalkorDB graph, proves which stores are clear, and drafts the recall for the coordinator to approve.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "https://recall-tracer.onrender.com"),
  title: { template: "%s · Recall Tracer", default: "Recall Tracer: targeted food recalls on a FalkorDB graph" },
  description,
  applicationName: "Recall Tracer",
  keywords: ["food recall", "traceability", "FSMA 204", "lot tracing", "FalkorDB", "graph database", "AI agent", "MCP"],
  openGraph: { type: "website", siteName: "Recall Tracer", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><TooltipProvider><Nav graphLine={<Suspense fallback={<GraphLineFallback />}><GraphLine /></Suspense>}>{children}</Nav></TooltipProvider></body>
    </html>
  );
}
