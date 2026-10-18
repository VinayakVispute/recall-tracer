"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DatabaseIcon, FileSearchIcon, HistoryIcon, MessageSquareIcon, PlayIcon, SearchIcon, SirenIcon, TruckIcon } from "lucide-react";
import type { IncidentSummary } from "@server/tools/incident";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { api, LOT_RE } from "@/lib/api";

const PAGES = [
  { href: "/outbreak", label: "Find the source", icon: SearchIcon },
  { href: "/notice", label: "Supplier notice", icon: SirenIcon },
  { href: "/incident", label: "Incident lookup", icon: TruckIcon },
  { href: "/history", label: "History", icon: HistoryIcon },
  { href: "/records", label: "Records", icon: DatabaseIcon },
  { href: "/agent", label: "Ask the agent", icon: MessageSquareIcon },
];
// The recorded runs, one per path the agent can take (same list as the incident lookup page).
const REPLAYS = [["L-204", "gaps, you decide"], ["L-205", "memory flags repeat gaps"], ["L-143", "one batch, no gaps"], ["L-108", "never used: hold only"]] as const;

/** Ctrl+K (⌘K) from anywhere: jump to a page, a recorded run, an incident in the graph, or a lot code you type. */
export function CommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  // Incidents are read each time the palette opens, so a run that just finished is there.
  useEffect(() => { if (open) api<IncidentSummary[]>("/incidents").then(setIncidents).catch(() => setIncidents([])); else setQ(""); }, [open]);

  const go = (href: string, hard = false) => { setOpen(false); if (hard) window.location.assign(href); else router.push(href); };
  const typed = q.trim().toUpperCase();
  const lot = LOT_RE.test(typed) ? typed : null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Search pages, lots and replays (Ctrl+K)"
        className="hidden h-9 items-center gap-2 rounded-full bg-card/80 px-3 text-sm text-muted-foreground ring-1 ring-foreground/7 transition-colors hover:text-foreground lg:inline-flex">
        <SearchIcon className="size-4" aria-hidden="true" />
        <span className="hidden xl:inline">Search</span>
        <kbd className="rounded border border-foreground/15 px-1.5 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Go to" description="Pages, recorded runs, incidents and lot codes">
        <Command>
          <CommandInput value={q} onValueChange={setQ} placeholder="Type a page, or a lot code like L-205…" />
          <CommandList>
            <CommandEmpty>Nothing matches. Type a lot code like L-204.</CommandEmpty>
            {lot && (
              <CommandGroup heading={`Lot ${lot}`}>
                <CommandItem value={`open ${lot}`} onSelect={() => go(`/incident/${lot}`)}><TruckIcon />Open the incident on {lot}</CommandItem>
                <CommandItem value={`notice ${lot}`} onSelect={() => go(`/notice?lot=${lot}`)}><SirenIcon />Supplier notice for {lot}</CommandItem>
              </CommandGroup>
            )}
            {incidents.length > 0 && (
              <CommandGroup heading="Incidents in the graph">
                {incidents.map((i) => (
                  <CommandItem key={i.id} value={`${i.lot} ${i.hazard} ${i.supplier}`} onSelect={() => go(`/incident/${i.lot}`)}>
                    <FileSearchIcon /><span className="font-mono">{i.lot}</span><span className="truncate text-muted-foreground">{i.hazard}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Watch a recorded run">
              {REPLAYS.map(([l, what]) => (
                <CommandItem key={l} value={`replay ${l} ${what}`} onSelect={() => go(`/incident/${l}?replay=1`, true)}>
                  <PlayIcon /><span className="font-mono">{l}</span><span className="text-muted-foreground">{what}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Pages">
              {PAGES.map((p, i) => (
                <CommandItem key={p.href} value={p.label} onSelect={() => go(p.href)}>
                  <p.icon />{p.label}{i < 3 && <CommandShortcut>Step {i + 1}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
