"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { fmtMs, graphTime, markersOf, type Recording, type TimedEvent } from "@/lib/trace";
import { TITLE, shortDate, shortTime } from "@/components/dashboard/panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TICK = 50;
const SPEEDS = [0.5, 1, 2, 4] as const;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const stepFromHash = () => {
  const m = typeof location !== "undefined" ? /^#step-(\d+)$/.exec(location.hash) : null;
  return m ? Number(m[1]) : undefined;
};

/** Plays a recording on a clock. Everything the dashboard shows is derived from the events up to the playhead. */
export function useReplay(rec: Recording | undefined) {
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const duration = rec?.events.at(-1)?.at ?? 0;
  const markers = useMemo(() => (rec ? markersOf(rec.events) : []), [rec]);

  // A new recording starts from the top, or from the step in the link (#step-6).
  useEffect(() => {
    if (!rec) return;
    const n = stepFromHash();
    const m = n ? markersOf(rec.events).find((x) => x.n === n) : undefined;
    setPos(m ? m.at : 0);
    setPlaying(!m);
  }, [rec]);

  useEffect(() => {
    if (!playing || !rec) return;
    const t = window.setInterval(() => setPos((p) => Math.min(duration, p + TICK * speed)), TICK);
    return () => clearInterval(t);
  }, [playing, speed, duration, rec]);
  useEffect(() => { if (playing && pos >= duration) setPlaying(false); }, [pos, duration, playing]);

  const current = [...markers].reverse().find((m) => m.at <= pos);
  // Keep the link pointing at the current step, without adding history entries.
  useEffect(() => {
    if (!rec || playing) return;
    const hash = current ? `#step-${current.n}` : "";
    if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
  }, [current, playing, rec]);

  const seek = (ms: number) => setPos(Math.max(0, Math.min(duration, ms)));
  const jump = (dir: 1 | -1) => {
    const next = dir > 0 ? markers.find((m) => m.at > pos) : [...markers].reverse().find((m) => m.at < pos - 1);
    seek(next ? next.at : dir > 0 ? duration : 0);
  };
  const toggle = () => { if (pos >= duration) setPos(0); setPlaying((p) => !p); };
  const restart = () => { setPos(0); setPlaying(true); };

  // Space plays or pauses, arrows step between agent steps. Ignored while typing.
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable], [role=combobox], [role=listbox]")) return;
      if (e.key === " " && !el.closest("button, a")) { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); jump(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); jump(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const visible: TimedEvent[] = useMemo(() => (rec ? rec.events.filter((e) => e.at <= pos) : []), [rec, pos]);
  return { pos, playing, speed, duration, markers, current, visible, seek, jump, toggle, restart, setSpeed, pause: () => setPlaying(false) };
}
export type Replay = ReturnType<typeof useReplay>;

const SOURCE: Record<Recording["source"], string> = {
  live: "Replay of the run you just watched",
  recorded: "Recorded live run from the server",
  estimated: "Saved run, step timing estimated",
};

/** Timeline under the record network: one marker per agent step at its real time, a draggable playhead, controls. */
export function ReplayBar({ rec, r, onExit }: { rec: Recording; r: Replay; onExit: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return ((clientX - box.left) / box.width) * r.duration;
  };
  const pct = (ms: number) => `${r.duration ? (100 * ms) / r.duration : 0}%`;
  const end = rec.events.findLast((e) => e.type === "tool_end" && e.at <= r.pos);
  const call = end?.type === "tool_end" ? end.call : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3" aria-label="Replay controls">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">Replay</Badge>
        <span>{SOURCE[rec.source]}, {shortDate(rec.recorded_at)} {shortTime(rec.recorded_at)}</span>
        <span className="ml-auto">Space play or pause, arrow keys step</span>
      </div>
      <div
        ref={track}
        className="relative h-7 cursor-pointer touch-none rounded-md bg-muted"
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(r.duration / 1000)}
        aria-valuenow={Math.round(r.pos / 1000)}
        aria-valuetext={`${clock(r.pos)} of ${clock(r.duration)}${r.current ? `, step ${r.current.n}, ${TITLE[r.current.name] ?? r.current.name}` : ""}`}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); r.pause(); r.seek(at(e.clientX)); }}
        onPointerMove={(e) => dragging.current && r.seek(at(e.clientX))}
        onPointerUp={() => (dragging.current = false)}
      >
        <div className="absolute inset-y-0 left-0 rounded-l-md bg-destructive/15" style={{ width: pct(r.pos) }} />
        {r.markers.map((m) => (
          <button
            key={m.n}
            type="button"
            title={`Step ${m.n}: ${TITLE[m.name] ?? m.name} at ${clock(m.at)}`}
            aria-label={`Jump to step ${m.n}, ${TITLE[m.name] ?? m.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { r.pause(); r.seek(m.at); }}
            className={cn(
              "absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-background text-[10px] font-semibold tabular-nums",
              m.error ? "border-destructive text-destructive" : m.judgement ? "border-chart-4 text-chart-4" : m.name === "trace_backward" ? "border-chart-3 text-chart-3" : "border-destructive text-destructive",
              m.at <= r.pos && (m.error ? "bg-destructive text-background" : m.judgement ? "bg-chart-4 text-background" : m.name === "trace_backward" ? "bg-chart-3 text-background" : "bg-destructive text-background"),
            )}
            style={{ left: pct(m.at) }}
          >{m.n}</button>
        ))}
        <div className="pointer-events-none absolute -inset-y-1 w-0.5 bg-foreground" style={{ left: pct(r.pos) }} />
      </div>
      <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground tabular-nums"><span>{clock(r.pos)}</span><span>{clock(r.duration)}</span></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={r.toggle}>{r.playing ? <><Pause />Pause</> : <><Play />{r.pos >= r.duration ? "Play again" : "Play"}</>}</Button>
        <Button size="sm" variant="outline" onClick={r.restart}><RotateCcw />Restart</Button>
        <div className="flex gap-1" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <Button key={s} size="sm" variant={r.speed === s ? "secondary" : "ghost"} aria-pressed={r.speed === s} onClick={() => r.setSpeed(s)}>{s}×</Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onExit}><X />Exit replay</Button>
      </div>
      <p className="min-h-10 rounded-md bg-background px-3 py-2 text-sm" aria-live="polite">
        {r.current && call
          ? <><b>Step {r.current.n} · {TITLE[call.name] ?? call.name}.</b> {call.summary}. <span className="text-muted-foreground">Tool {call.name}, {graphTime(call).db ? `${fmtMs(graphTime(call).ms)} in FalkorDB` : `${call.ms} ms`}.</span></>
          : <span className="text-muted-foreground">The agent is reading the supplier notice. Records light up as it reaches them.</span>}
      </p>
    </div>
  );
}
