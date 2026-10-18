"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DatabaseIcon, HistoryIcon, PlayIcon, MessageSquareIcon, SearchIcon, SirenIcon, TruckIcon } from "lucide-react";
import type { IncidentSummary } from "@server/tools/incident";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
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
// Pages reachable by address but not listed (the real-data page used in the pitch).
const TITLES: Record<string, string> = { "/real": "Real outbreak records" };

const on = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Status in the coordinator's words: what is happening, or what they need to do next. */
function statusOf(i: IncidentSummary) {
  if (i.status === "open") return { text: "Tracing", tone: "text-muted-foreground" };
  if (i.status === "notices_approved") return { text: "Notices approved", tone: "text-muted-foreground" };
  return i.confirmed_class
    ? { text: `Class ${i.confirmed_class} confirmed · approve notices`, tone: "text-chart-1" }
    : { text: "Waiting for your confirmation", tone: "text-chart-1" };
}

/** Sent by the incident page when it opens, scopes or confirms an incident, so the sidebar card updates without a navigation. */
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

/** On a phone the sidebar is a sheet over the page: close it once a link has taken you somewhere. */
function CloseOnNavigate({ pathname }: { pathname: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => { if (isMobile) setOpenMobile(false); }, [pathname, isMobile, setOpenMobile]);
  return null;
}

/** The app shell. `graphLine` is a server component passed in by the layout, streamed under its own Suspense boundary. */
export function Nav({ graphLine, children }: { graphLine: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  const inc = useOpenIncident(pathname);
  const step = STEPS.findIndex((s) => on(pathname, s.href));
  // Step 3 opens the incident being worked, not a search box; the list is still one click away from there.
  const hrefOf = (href: string) => (href === "/incident" && inc ? `/incident/${inc.lot}` : href);
  const status = inc && statusOf(inc);
  return (
    <SidebarProvider>
      <CloseOnNavigate pathname={pathname} />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link href="/outbreak" />}>
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground">R</span>
                <span className="flex flex-col leading-tight"><span className="font-semibold">Recall Tracer</span><span className="text-xs text-muted-foreground">Northfield Foods</span></span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {inc && status && (
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel>Open incident</SidebarGroupLabel>
              <SidebarGroupContent>
                <Link href={`/incident/${inc.lot}`} aria-current={pathname === `/incident/${inc.lot}` ? "page" : undefined}
                  className={cn("flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent", pathname === `/incident/${inc.lot}` && "border-sidebar-ring")}>
                  <span className="font-medium">Lot {inc.lot}</span>
                  <span className="truncate text-xs text-destructive">{inc.hazard}</span>
                  <span className={cn("text-xs", status.tone)}>{status.text}</span>
                </Link>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          <SidebarGroup>
            <SidebarGroupLabel>Recall</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {STEPS.map((s, i) => (
                  <SidebarMenuItem key={s.href}>
                    <SidebarMenuButton isActive={i === step} tooltip={`${i + 1}. ${s.label}`} render={<Link href={hrefOf(s.href)} />}>
                      <s.icon />
                      <span>{i + 1}. {s.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>More</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {MORE.map((m) => (
                  <SidebarMenuItem key={m.href}>
                    <SidebarMenuButton isActive={on(pathname, m.href)} tooltip={m.label} render={<Link href={m.href} />}>
                      <m.icon />
                      <span>{m.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{graphLine}</SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b bg-background px-4 py-2 text-sm">
          <SidebarTrigger className="-ml-1" />
          {step >= 0
            ? <p><span className="font-semibold">Step {step + 1} of 3 · {STEPS[step].label}</span><span className="hidden text-muted-foreground md:inline">. {STEPS[step].lead}</span></p>
            : <p className="font-semibold">{MORE.find((m) => on(pathname, m.href))?.label ?? TITLES[pathname]}</p>}
          {/* A plain link, so it starts the replay even from the incident page itself. No API key needed. */}
          <a href="/incident/L-204?replay=1" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />Watch a recall<span className="hidden sm:inline">&nbsp;in 40 s</span>
          </a>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
