"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DatabaseIcon, HistoryIcon, PlayIcon, MessageSquareIcon, SearchIcon, SirenIcon, TruckIcon } from "lucide-react";
import type { IncidentSummary } from "@server/tools/incident";
import { Logo } from "@/components/logo";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// The order a coordinator works in. Most recalls start at step 2, from a supplier's notice.
const STEPS = [
  { href: "/outbreak", label: "Find the source", icon: SearchIcon, lead: "Start from illness reports and find the lot behind them, in your records or in public recalls." },
  { href: "/notice", label: "Supplier notice", icon: SirenIcon, lead: "Enter the lot and hazard from the supplier's alert to open the incident and start the 24-hour clock." },
  { href: "/incident", label: "Incident", icon: TruckIcon, lead: "Which stores pull, which are cleared, and the notices to approve. Every number comes from the graph." },
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

const pill = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** The app shell: a top bar with the steps as pills. `graphLine` is a server component passed in by the layout, streamed under its own Suspense boundary. */
export function Nav({ graphLine, children }: { graphLine: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  const inc = useOpenIncident(pathname);
  const step = STEPS.findIndex((s) => on(pathname, s.href));
  // Step 3 opens the incident being worked, not a search box; the list is still one click away from there.
  const hrefOf = (href: string) => (href === "/incident" && inc ? `/incident/${inc.lot}` : href);
  const status = inc && statusOf(inc);
  const link = (active: boolean) => cn(pill, active ? "bg-secondary text-foreground ring-1 ring-foreground/10" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground");
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 border-b border-foreground/6 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-none items-center gap-4 px-4 py-3">
          <Link href="/outbreak" className="flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Logo className="size-8" />
            <span className="hidden flex-col leading-tight sm:flex"><span className="font-semibold tracking-tight">Recall Tracer</span><span className="text-xs text-muted-foreground">Northfield Foods</span></span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 flex-1 justify-center">
            <ul className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full p-1 [scrollbar-width:none]">
              {STEPS.map((s, i) => (
                <li key={s.href}>
                  <Link href={hrefOf(s.href)} title={s.lead} aria-current={i === step ? "page" : undefined} className={link(i === step)}>
                    <s.icon className="size-3.5" aria-hidden="true" /><span className="text-muted-foreground/70">{i + 1}</span>{s.label}
                  </Link>
                </li>
              ))}
              <li aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-foreground/10" />
              {MORE.map((m) => (
                <li key={m.href}>
                  <Link href={m.href} aria-current={on(pathname, m.href) ? "page" : undefined} className={link(on(pathname, m.href))}>
                    <m.icon className="size-3.5" aria-hidden="true" />{m.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            {inc && status && (
              <Link href={`/incident/${inc.lot}`} title={`${inc.hazard}. ${status.text}`}
                className={cn(pill, "hidden bg-secondary/60 ring-1 ring-foreground/10 hover:bg-secondary xl:inline-flex", pathname === `/incident/${inc.lot}` && "ring-foreground/25")}>
                <span className={cn("size-2 rounded-full", status.tone)} aria-hidden="true" />
                <span className="font-medium">Lot {inc.lot}</span>
                <span className="text-muted-foreground">{status.text}</span>
              </Link>
            )}
            {/* A plain link, so it starts the replay even from the incident page itself. No API key needed. */}
            <a href="/incident/L-204?replay=1" className={cn(pill, "bg-primary font-medium text-primary-foreground hover:bg-primary/90")}>
              <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />Watch a recall<span className="hidden sm:inline">&nbsp;in 40 s</span>
            </a>
          </div>
        </div>
        {step >= 0 && <p className="mx-auto hidden w-full max-w-none px-4 pb-2.5 text-xs text-muted-foreground md:block"><span className="font-medium text-foreground">Step {step + 1} of 3 · {STEPS[step].label}.</span> {STEPS[step].lead}</p>}
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
      <footer className="mx-auto w-full max-w-none px-4 py-4 text-xs text-muted-foreground">{graphLine}</footer>
    </div>
  );
}
