"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// The order a coordinator works in: find the source, take the supplier's notice, run the incident.
const LINKS = [
  { href: "/outbreak", label: "Outbreak" },
  { href: "/notice", label: "Supplier notice" },
  { href: "/incident", label: "Incident" },
  { href: "/history", label: "History" },
];

/** `graphLine` is a server component passed in by the layout, streamed under its own Suspense boundary. */
export function Nav({ graphLine }: { graphLine: React.ReactNode }) {
  const pathname = usePathname();
  const link = (href: string, label: string, extra?: string) => {
    const on = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link key={href} href={href} aria-current={on ? "page" : undefined}
        className={cn("rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground", on && "bg-muted text-foreground", extra)}>
        {label}
      </Link>
    );
  };
  return (
    <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center gap-x-6 gap-y-1 border-b bg-background px-4 py-2">
      <span className="font-semibold">Recall Tracer</span>
      <nav aria-label="Sections" className="flex flex-wrap items-center gap-1 text-sm">{LINKS.map((l) => link(l.href, l.label))}</nav>
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {graphLine}
        {/* The recorded L-204 run, played back with its real timings: the demo path that needs no Claude key.
            A full page load, not <Link>: from an open incident, a client navigation would keep the old view mounted. */}
        <a href="/incident/L-204?replay=1" className="rounded-md px-2.5 py-1 hover:text-foreground">⟳ Replay demo</a>
        {link("/agent", "Ask the agent", "text-xs")}
      </div>
    </header>
  );
}
