"use client";

import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Toast = { id: number; text: string; tone: "ok" | "error" };
const EVENT = "recall-tracer:toast";

/** Confirms an action in a short message at the bottom right. Callable from any client component; <Toaster /> shows it. */
export function toast(text: string, tone: Toast["tone"] = "ok") {
  window.dispatchEvent(new CustomEvent<Omit<Toast, "id">>(EVENT, { detail: { text, tone } }));
}

/** The toast stack, mounted once in the layout. Each toast stays 3.5 s; errors stay until closed. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const t = { ...(e as CustomEvent<Omit<Toast, "id">>).detail, id: ++n };
      setList((l) => [...l.slice(-2), t]);
      if (t.tone === "ok") setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 3500);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <ol aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <li key={t.id} role={t.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex animate-in items-start gap-3 rounded-xl bg-popover px-4 py-3 text-sm shadow-xl ring-1 ring-foreground/10 fade-in slide-in-from-bottom-2">
          <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", t.tone === "ok" ? "bg-chart-2 text-background" : "bg-destructive text-background")} aria-hidden="true">
            {t.tone === "ok" ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
          </span>
          <span className="flex-1">{t.text}</span>
          <button type="button" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <XIcon className="size-3.5" />
          </button>
        </li>
      ))}
    </ol>
  );
}
