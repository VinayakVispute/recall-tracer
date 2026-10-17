"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DatabaseIcon, HistoryIcon, MessageSquareIcon, PlayIcon, SearchIcon, SirenIcon, TruckIcon } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from "@/components/ui/sidebar";
import { IncidentStrip } from "./incident-strip";

// The order a coordinator works in: find the source, take the supplier's notice, run the incident.
const STEPS = [
  { href: "/outbreak", label: "Find the source", icon: SearchIcon, lead: "People are sick in several states. Press Find the source and the agent walks every case back through stores and batches to the ingredient lot they share." },
  { href: "/notice", label: "Open incident", icon: SirenIcon, lead: "The supplier's alert names a lot. Enter it and the incident opens, starting the 24-hour FDA clock." },
  { href: "/incident", label: "Scope and notify", icon: TruckIcon, lead: "Which product lots contain the bad lot, which stores pull and which are cleared, and the notices to send. Every number is read from the graph." },
];
const MORE = [
  { href: "/history", label: "History", icon: HistoryIcon },
  { href: "/real", label: "Real data", icon: DatabaseIcon },
  { href: "/agent", label: "Ask the agent", icon: MessageSquareIcon },
];

const on = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** The app shell. `graphLine` is a server component passed in by the layout, streamed under its own Suspense boundary. */
export function Nav({ graphLine, children }: { graphLine: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  const step = STEPS.findIndex((s) => on(pathname, s.href));
  return (
    <SidebarProvider>
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
          <SidebarGroup>
            <SidebarGroupLabel>Recall in 3 steps</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {STEPS.map((s, i) => (
                  <SidebarMenuItem key={s.href}>
                    <SidebarMenuButton isActive={i === step} tooltip={`${i + 1}. ${s.label}`} render={<Link href={s.href} />}>
                      <s.icon />
                      <span>{i + 1}. {s.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Demo</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  {/* The recorded L-204 run with its real timings: the demo path that needs no Claude key.
                      A full page load, not <Link>: from an open incident, a client navigation would keep the old view mounted. */}
                  <SidebarMenuButton tooltip="Replay demo" render={<a href="/incident/L-204?replay=1" />}>
                    <PlayIcon />
                    <span>Replay demo</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
        <header className="sticky top-0 z-40 flex flex-col gap-2 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-3 text-sm">
            <SidebarTrigger className="-ml-1" />
            {step >= 0
              ? <p><span className="font-semibold">Step {step + 1} of 3 · {STEPS[step].label}.</span> <span className="text-muted-foreground">{STEPS[step].lead}</span></p>
              : <p className="font-semibold">{MORE.find((m) => on(pathname, m.href))?.label}</p>}
          </div>
          <IncidentStrip pathname={pathname} />
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
