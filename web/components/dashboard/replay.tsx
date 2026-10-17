"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward, X } from "lucide-react";
import { fmtMs, graphTime, markersOf, type Recording, type TimedEvent } from "@/lib/trace";
import { TITLE, shortDate, shortTime } from "@/components/dashboard/panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TICK = 50;
const SPEEDS = [0.5, 1, 2] as const;
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

// Step colours follow the rest of the dashboard: judgement steps as in the log, the backward check as on the graph.
const TONE = { step: "var(--foreground)", judgement: "var(--chart-4)", backward: "var(--chart-3)", error: "var(--destructive)" };
const toneOf = (m: { name: string; judgement: boolean; error: boolean }) =>
  m.error ? TONE.error : m.judgement ? TONE.judgement : m.name === "trace_backward" ? TONE.backward : TONE.step;

/** Media-player controls under the record network: play, step, restart, speed, and a scrubber with one dot per agent step. */
export function ReplayBar({ rec, r, onExit }: { rec: Recording; r: Replay; onExit: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return ((clientX - box.left) / box.width) * r.duration;
  };
  const pct = (ms: number) => `${r.duration ? (100 * ms) / r.duration : 0}%`;
  const end = rec.events.findLast((e) => e.type === "tool_end" && e.at <= r.pos);
  const call = end?.type === "tool_end" ? end.call : undefined;
  // Dots sit at their real time; the step numbers under them are nudged apart when parallel steps finish together.
  const num: number[] = [];
  r.markers.forEach((m, i) => num.push(Math.max((r.duration ? m.at / r.duration : 0) * width, i ? num[i - 1] + 18 : 6)));
  const jumpTo = (ms: number) => { r.pause(); r.seek(ms); };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" aria-label="Replay controls">
      <div className="flex flex-wrap items-center gap-1">
        <Button size="icon-lg" className="mr-1 size-10 rounded-full" onClick={r.toggle} aria-label={r.playing ? "Pause" : r.pos >= r.duration ? "Play again" : "Play"} title="Space">
          {r.playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => { r.pause(); r.jump(-1); }} aria-label="Previous step" title="Previous step (←)"><SkipBack /></Button>
        <Button size="icon" variant="ghost" onClick={() => { r.pause(); r.jump(1); }} aria-label="Next step" title="Next step (→)"><SkipForward /></Button>
        <Button size="icon" variant="ghost" onClick={r.restart} aria-label="Restart" title="Restart"><RotateCcw /></Button>
        <span className="ml-2 font-mono text-sm tabular-nums" aria-hidden="true">{clock(r.pos)}<span className="text-muted-foreground"> / {clock(r.duration)}</span></span>
        <div className="ml-auto inline-flex rounded-md border p-0.5" role="group" aria-label="Replay speed">
          {SPEEDS.map((sp) => (
            <button key={sp} type="button" aria-pressed={r.speed === sp} onClick={() => r.setSpeed(sp)}
              className={cn("rounded px-2.5 py-0.5 text-xs font-semibold tabular-nums transition-colors", r.speed === sp ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>{sp}×</button>
          ))}
        </div>
        <Button size="icon" variant="ghost" onClick={onExit} aria-label="Exit replay" title="Exit replay"><X /></Button>
      </div>

      <div
        ref={track}
        className="group relative h-5 cursor-pointer touch-none"
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
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/70" style={{ width: pct(r.pos) }} />
        {r.markers.map((m) => (
          <span key={m.n} className={cn("pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card", r.current?.n === m.n ? "size-3.5" : "size-2.5")}
            style={{ left: pct(m.at), background: toneOf(m), opacity: m.at <= r.pos ? 1 : 0.45 }} />
        ))}
        <span className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow ring-4 ring-primary/15 transition-transform group-active:scale-110" style={{ left: pct(r.pos) }} />
      </div>
      <div className="relative h-4 text-[11px] font-semibold tabular-nums">
        {r.markers.map((m, i) => (
          <button key={m.n} type="button" onClick={() => jumpTo(m.at)} title={`Step ${m.n}: ${TITLE[m.name] ?? m.name} at ${clock(m.at)}`}
            aria-label={`Jump to step ${m.n}, ${TITLE[m.name] ?? m.name}`} aria-current={r.current?.n === m.n ? "step" : undefined}
            className={cn("absolute -translate-x-1/2 rounded px-1 leading-4 hover:bg-muted", r.current?.n !== m.n && "opacity-60")}
            style={{ left: Math.min(num[i], width - 6), color: toneOf(m) }}>{m.n}</button>
        ))}
      </div>

      <p className="flex min-h-5 flex-wrap items-baseline gap-x-1.5 text-sm" aria-live="polite">
        {r.current && call ? <>
          <span className="inline-block size-2 shrink-0 self-center rounded-full" style={{ background: toneOf(r.current) }} aria-hidden="true" />
          <b>Step {r.current.n} · {TITLE[call.name] ?? call.name}</b>
          <span className="text-muted-foreground">· {call.summary} · {graphTime(call).db ? `FalkorDB ${fmtMs(graphTime(call).ms)}` : `${call.ms} ms`}</span>
        </> : <span className="text-muted-foreground">The agent is reading the supplier notice. Records light up as it reaches them.</span>}
      </p>
      <p className="text-xs text-muted-foreground">{SOURCE[rec.source]}, {shortDate(rec.recorded_at)} {shortTime(rec.recorded_at)} · ← → step · space play or pause</p>
    </div>
  );
}
