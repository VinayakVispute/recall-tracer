"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DatabaseIcon, HistoryIcon, PlayIcon, MessageSquareIcon } from "lucide-react";
import type { IncidentSummary } from "@server/tools/incident";
import { CommandMenu } from "@/components/command-menu";
import { Logo } from "@/components/logo";
import { SiteFooter } from "@/components/site-footer";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// The order a coordinator works in. Most recalls start at step 2, from a supplier's notice.
const STEPS = [
  { href: "/outbreak", label: "Find the source", lead: "Start from illness reports and find the lot behind them, in your records or in public recalls." },
  { href: "/notice", label: "Supplier notice", lead: "Enter the lot and hazard from the supplier's alert to open the incident and start the 24-hour clock." },
  { href: "/incident", label: "Incident", lead: "Which stores pull, which are cleared, and the notices to approve. Every number comes from the graph." },
];
const MORE = [
  { href: "/history", label: "History", icon: HistoryIcon },
  { href: "/records", label: "Records", icon: DatabaseIcon },
  { href: "/agent", label: "Ask the agent", icon: MessageSquareIcon },
];

const on = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Status in the coordinator's words: what is happening, or what they need to do next. */
function statusOf(i: IncidentSummary) {
  if (i.status === "open") return { text: "Tracing", tone: "bg-muted-foreground" };
  if (i.status === "notices_approved") return { text: "Notices approved", tone: "bg-chart-2" };
  return i.confirmed_class
    ? { text: `Class ${i.confirmed_class} · approve notices`, tone: "bg-chart-1" }
    : { text: "Needs your confirmation", tone: "bg-chart-1" };
}

/** Sent by the incident page when it opens, scopes or confirms an incident, so the header chip updates without a navigation. */
export const INCIDENT_CHANGED = "recall-tracer:incident-changed";

/** The newest incident in the graph, re-read on every navigation and whenever the incident page reports a change. */
function useOpenIncident(pathname: string) {
  const [inc, setInc] = useState<IncidentSummary | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api<IncidentSummary[]>("/incidents").then((list) => { if (live) setInc(list[0] ?? null); }).catch(() => { if (live) setInc(null); });
    read();
    window.addEventListener(INCIDENT_CHANGED, read);
    return () => { live = false; window.removeEventListener(INCIDENT_CHANGED, read); };
  }, [pathname]);
  return inc;
}

const pill = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** The app shell: a top bar with the steps as pills. `graphLine` is a server component passed in by the layout, streamed under its own Suspense boundary. */
export function Nav({ graphLine, children }: { graphLine: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  const inc = useOpenIncident(pathname);
  const step = STEPS.findIndex((s) => on(pathname, s.href));
  // Step 3 opens the incident being worked, not a search box; the list is still one click away from there.
  const hrefOf = (href: string) => (href === "/incident" && inc ? `/incident/${inc.lot}` : href);
  const status = inc && statusOf(inc);
  const link = (active: boolean) => cn(pill, active
    ? "bg-secondary text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_1px_2px_rgb(0_0_0/0.4)] ring-1 ring-foreground/10"
    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground");
  const needsYou = status?.tone === "bg-chart-1";
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl">
        <div className="flex w-full items-center gap-4 px-4 py-2.5">
          <Link href="/outbreak" className="flex shrink-0 items-center gap-2.5 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Logo className="size-9 drop-shadow-[0_2px_8px_rgb(248_113_113/0.15)]" />
            <span className="hidden flex-col leading-tight sm:flex"><span className="font-semibold tracking-tight">Recall Tracer</span><span className="text-xs text-muted-foreground">Northfield Foods</span></span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 flex-1 justify-center">
            {/* One capsule for every page: the three steps, numbered, then the rest. */}
            <ul className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-card/80 p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] ring-1 ring-foreground/7">
              {STEPS.map((s, i) => (
                <li key={s.href}>
                  <Link href={hrefOf(s.href)} title={s.lead} aria-current={i === step ? "page" : undefined} className={link(i === step)}>
                    <span aria-hidden="true" className={cn("grid size-5 place-items-center rounded-full text-[11px] font-semibold tabular-nums transition-colors",
                      i === step ? "bg-foreground text-background" : i < step ? "bg-foreground/15 text-foreground" : "ring-1 ring-foreground/20")}>{i + 1}</span>
                    {s.label}
                  </Link>
                </li>
              ))}
              <li aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 bg-foreground/10" />
              {MORE.map((m) => (
                <li key={m.href}>
                  <Link href={m.href} title={m.label} aria-current={on(pathname, m.href) ? "page" : undefined} className={link(on(pathname, m.href))}>
                    <m.icon className="size-4" aria-hidden="true" /><span className="sr-only xl:not-sr-only">{m.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <CommandMenu />
            {inc && status && (
              <Link href={`/incident/${inc.lot}`} title={`${inc.hazard}. ${status.text}`}
                className={cn(pill, "hidden bg-card/80 ring-1 ring-foreground/7 hover:bg-secondary 2xl:inline-flex", pathname === `/incident/${inc.lot}` && "ring-foreground/20")}>
                <span className="relative flex size-2" aria-hidden="true">
                  {needsYou && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-75", status.tone)} />}
                  <span className={cn("relative inline-flex size-2 rounded-full", status.tone)} />
                </span>
                <span className="font-medium">Lot {inc.lot}</span>
                <span className="text-muted-foreground">{status.text}</span>
              </Link>
            )}
            {/* A plain link, so it starts the replay even from the incident page itself. No API key needed. */}
            <a href="/incident/L-204?replay=1" className={cn(pill, "bg-primary py-1.5 pr-1.5 pl-1.5 font-medium sm:pr-4 text-primary-foreground shadow-[0_0_24px_rgb(255_255_255/0.08)] hover:bg-primary/90")}>
              <span className="grid size-6 place-items-center rounded-full bg-primary-foreground text-primary" aria-hidden="true"><PlayIcon className="ml-px size-3 fill-current" /></span>
              <span className="sr-only sm:not-sr-only">Watch a recall</span><span className="hidden text-primary-foreground/60 md:inline">&nbsp;· 40 s</span>
            </a>
          </div>
        </div>
        {/* The bottom edge doubles as progress through the three steps; off the steps it is a plain hairline. */}
        <div className="h-px bg-foreground/7" aria-hidden="true">
          {step >= 0 && <div className="h-px bg-gradient-to-r from-transparent via-foreground/50 to-foreground transition-[width] duration-500" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />}
        </div>
      </header>
      {/* Striped columns down both sides of the page on wider screens; the content sits between them. */}
      {/* minmax(0,1fr) on phones too: a bare grid column would grow to its widest child and push pages off screen. */}
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[var(--rail-width)_minmax(0,1fr)_var(--rail-width)]">
        <div aria-hidden="true" className="rail hidden md:block" />
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-1 flex-col">{children}</div>
          <SiteFooter graphLine={graphLine} />
        </div>
        <div aria-hidden="true" className="rail hidden md:block" />
      </div>
    </div>
  );
}
