import Link from "next/link";
import { PlayIcon, SirenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * Shown where a page would otherwise be empty (a fresh graph, no incidents yet), so a first visit always has a next
 * step: the recorded run needs no API key, the live run opens the same lot from the supplier notice.
 */
export function StartHere({ title = "Start here", lead, className }: { title?: string; lead?: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl bg-card p-5 ring-1 ring-foreground/7 sm:p-6", className)}>
      <div aria-hidden="true" className="pointer-events-none absolute -top-20 -right-16 size-64 rounded-full bg-destructive/10 blur-3xl" />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex max-w-xl flex-col gap-1">
          <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">{title}</p>
          <p className="text-lg font-medium tracking-tight">See a targeted recall from notice to notices</p>
          <p className="text-sm text-muted-foreground">{lead ?? "Lot L-204 is a contaminated carrot lot that reached 31 stores. Watch the recorded agent run, or open it live and decide the gap stores yourself."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/incident/L-204?replay=1" className={cn(buttonVariants(), "rounded-full")}>
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />Watch the 40 s replay
          </a>
          <Link href="/notice?lot=L-204" className={cn(buttonVariants({ variant: "outline" }), "rounded-full")}>
            <SirenIcon className="size-3.5" aria-hidden="true" />Open L-204 live
          </Link>
        </div>
      </div>
    </div>
  );
}
