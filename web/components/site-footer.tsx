import Link from "next/link";
import { Logo } from "@/components/logo";

const LINKS = [
  { href: "/outbreak", label: "Find the source" },
  { href: "/notice", label: "Supplier notice" },
  { href: "/incident", label: "Incident" },
  { href: "/history", label: "History" },
  { href: "/records", label: "Records" },
  { href: "/agent", label: "Ask the agent" },
];

// The story, on a 12 s loop (timings in globals.css): a supplier flags a lot, the trace follows it through the plant
// to the DC, the DC holds what hasn't shipped, the trace reaches two of three stores, and trucks bring product back
// from only those two. The third store is proven clear.
const ROAD_Y = 150, FORK_X = 980, STORE_X = 1300;
const TRUNK_STOPS = [
  { x: 170, n: "01", label: "Supplier flags a lot", sub: "a contaminated ingredient" },
  { x: 570, n: "02", label: "Trace the batches", sub: "through the plant and rework" },
  { x: 874, n: "03", label: "Hold at the DC", sub: "stop what hasn't shipped" },
];
// Each store sits at the end of one branch from the fork; `pull` stores are the ones the trace reaches.
const STORES = [
  { y: 62, pull: true, path: `M${FORK_X} ${ROAD_Y} C1100 ${ROAD_Y} 1140 62 ${STORE_X} 62` },
  { y: 150, pull: false, path: `M${FORK_X} ${ROAD_Y} H${STORE_X}` },
  { y: 238, pull: true, path: `M${FORK_X} ${ROAD_Y} C1100 ${ROAD_Y} 1140 238 ${STORE_X} 238` },
];
// The way back for a recall truck: from a pulled store to the fork, then to the DC.
const backFrom = (y: number) => `path("M${STORE_X} ${y} C1140 ${y} 1100 ${ROAD_Y} ${FORK_X} ${ROAD_Y} H880")`;
// A faint skyline behind the trunk: [x, width, height].
const SKYLINE = [[60, 40, 34], [104, 26, 52], [250, 54, 28], [330, 30, 46], [380, 44, 22], [660, 36, 40], [720, 60, 26], [960, 28, 40]];

/** A truck, wheels on y = 0, facing right. `cargo` is the lot (a red crate); `back` faces it left, driving a recall home. */
function Truck({ cargo, back }: { cargo?: boolean; back?: boolean }) {
  const line = "stroke-foreground/75";
  return (
    <g transform={back ? "scale(-1 1)" : undefined}>
      <rect x="0" y="-38" width="58" height="29" rx="3" className={`fill-card ${line}`} strokeWidth="2" />
      <path d="M58 -31 h16 l11 13 v9 h-27 z" className={`fill-card ${line}`} strokeWidth="2" strokeLinejoin="round" />
      <path d="M63 -27 h9 l7 8 h-16 z" className="fill-foreground/20" />
      <circle cx="16" cy="-5" r="6" className={`fill-background ${line}`} strokeWidth="2" />
      <circle cx="70" cy="-5" r="6" className={`fill-background ${line}`} strokeWidth="2" />
      {cargo && <rect x="17" y="-31" width="18" height="15" rx="2" className="footer-lot fill-destructive" />}
    </g>
  );
}

/** A status tag beside a store or over the DC. */
function Tag({ x, y, text, tone }: { x: number; y: number; text: string; tone: "pull" | "clear" | "hold" }) {
  const cls = tone === "pull" ? "fill-destructive/15 stroke-destructive" : tone === "clear" ? "fill-chart-2/15 stroke-chart-2" : "fill-card stroke-foreground/60";
  const ink = tone === "pull" ? "fill-destructive" : tone === "clear" ? "fill-chart-2" : "fill-foreground";
  const w = text.length * 8 + 22;
  return (
    <g>
      <rect x={x} y={y - 11} width={w} height="22" rx="11" className={cls} strokeWidth="1.5" />
      <text x={x + w / 2} y={y + 4} textAnchor="middle" className={`${ink} font-mono text-[11px] font-semibold tracking-[0.12em]`}>{text}</text>
    </g>
  );
}

/** How a recall works, drawn: the trace through the supply chain, the hold, and a targeted pull. Decorative; the text says the same. */
function RecallScene() {
  const stop = "fill-none stroke-foreground/55";
  return (
    <svg viewBox="0 0 1600 290" className="relative block h-auto w-full" aria-hidden="true">
      <g className="fill-foreground/[0.04]">
        {SKYLINE.map(([x, w, h]) => <rect key={x} x={x} y={ROAD_Y - h} width={w} height={h} rx="2" />)}
      </g>

      {/* 01 Supplier: stacked crates, with the alert that starts it all */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <rect x="138" y="118" width="32" height="32" rx="2" /><path d="M138 134 h32 M154 118 v32" />
        <rect x="174" y="118" width="32" height="32" rx="2" /><path d="M174 134 h32 M190 118 v32" />
        <rect x="156" y="84" width="32" height="32" rx="2" /><path d="M156 100 h32 M172 84 v32" />
      </g>
      <g className="footer-alert">
        <path d="M222 50 L242 84 H202 Z" className="fill-destructive" strokeLinejoin="round" />
        <text x="222" y="79" textAnchor="middle" className="fill-background text-[18px] font-bold">!</text>
      </g>

      {/* 02 Plant */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <path d="M526 150 V100 L555 115 V100 L584 115 V100 L614 115 V150 Z" />
        <rect x="536" y="70" width="12" height="36" />
        <path d="M545 150 v-15 h15 v15 M578 126 h22 v11 h-22 z" />
      </g>
      <g className="fill-foreground/20">
        <circle cx="542" cy="58" r="6" className="footer-smoke" />
        <circle cx="552" cy="44" r="8" className="footer-smoke [animation-delay:-1.5s]" />
      </g>

      {/* 03 Distribution centre, and the hold placed on it */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <path d="M820 150 V106 L874 80 L928 106 V150 Z" />
        <rect x="854" y="116" width="40" height="34" />
        <path d="M854 124 h40 M854 132 h40 M854 140 h40" />
      </g>
      <g className="footer-show-hold"><Tag x={826} y={58} text="ON HOLD" tone="hold" /></g>

      {/* Roads: the trunk to the fork, then one branch per store */}
      <path d={`M40 ${ROAD_Y} H${FORK_X}`} className="stroke-foreground/30" strokeWidth="2" />
      <path d={`M40 ${ROAD_Y + 9} H${FORK_X - 20}`} className="stroke-foreground/15" strokeWidth="2" strokeDasharray="16 12" />
      {STORES.map((s) => <path key={s.y} d={s.path} className="fill-none stroke-foreground/30" strokeWidth="2" strokeDasharray={s.pull ? undefined : "6 6"} />)}

      {/* The trace: along the trunk first, then only down the branches to stores that got the lot */}
      <path d={`M40 ${ROAD_Y} H${FORK_X}`} className="footer-trace-trunk stroke-destructive" strokeWidth="2.5" strokeLinecap="round" pathLength={1} />
      {STORES.filter((s) => s.pull).map((s) => (
        <path key={s.y} d={s.path} className="footer-trace-branch fill-none stroke-destructive" strokeWidth="2.5" strokeLinecap="round" pathLength={1} />
      ))}
      {[...TRUNK_STOPS.map((t) => t.x), FORK_X].map((x) => <circle key={x} cx={x} cy={ROAD_Y} r="5" className="fill-background stroke-foreground/60" strokeWidth="2" />)}

      {/* 04 Stores: pull the two the trace reached, clear the third */}
      {STORES.map((s) => (
        <g key={s.y}>
          <g className={stop} strokeWidth="2" strokeLinejoin="round">
            <rect x={STORE_X + 6} y={s.y - 30} width="54" height="30" />
            <path d={`M${STORE_X + 2} ${s.y - 30} L${STORE_X + 9} ${s.y - 42} H${STORE_X + 57} L${STORE_X + 64} ${s.y - 30} Z`} />
            <rect x={STORE_X + 27} y={s.y - 20} width="12" height="20" />
          </g>
          <g className="footer-show-tags"><Tag x={STORE_X + 80} y={s.y - 16} text={s.pull ? "PULL" : "✓ CLEAR"} tone={s.pull ? "pull" : "clear"} /></g>
        </g>
      ))}

      {/* Labels for the first three steps, under the trunk; the fourth sits under the stores */}
      {TRUNK_STOPS.map((t) => (
        <g key={t.n}>
          <text x={t.x} y={ROAD_Y + 32} textAnchor="middle" className="fill-foreground font-mono text-[12px] uppercase tracking-[0.14em]">
            <tspan className="fill-muted-foreground">{t.n} </tspan>{t.label}
          </text>
          <text x={t.x} y={ROAD_Y + 48} textAnchor="middle" className="fill-muted-foreground text-[11px]">{t.sub}</text>
        </g>
      ))}
      <text x={STORE_X - 10} y="274" className="fill-foreground font-mono text-[12px] uppercase tracking-[0.14em]">
        <tspan className="fill-muted-foreground">04 </tspan>Pull only the stores it reached
      </text>

      {/* The lot travelling in, then recall trucks bringing it back from the two stores */}
      <g transform={`translate(0 ${ROAD_Y})`}><g className="footer-deliver"><Truck cargo /></g></g>
      {STORES.filter((s) => s.pull).map((s, i) => (
        // The second truck runs 0.6 s behind the first. A negative delay (12 s - 0.6 s) keeps it from sitting parked before it starts.
        <g key={s.y} className="footer-recall" style={{ offsetPath: backFrom(s.y), animationDelay: i ? "-11.4s" : undefined }}><Truck cargo back /></g>
      ))}
    </svg>
  );
}

/** The footer on every page: the recall graphic, then the brand, the page links and the FalkorDB status, over a large faint wordmark. */
export function SiteFooter({ graphLine }: { graphLine: React.ReactNode }) {
  return (
    <footer className="px-4 pt-10 pb-4">
      <div className="relative overflow-hidden rounded-3xl bg-card ring-1 ring-foreground/7">
        {/* Dot grid, faded towards the edges */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle,var(--foreground)_1px,transparent_1px)] [background-size:22px_22px] opacity-[0.07] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="relative px-4 pt-8 sm:px-8">
          <p className="mb-2 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">How a targeted recall works</p>
          <RecallScene />
          <p className="sr-only">A supplier flags a contaminated lot. The trace follows it through the plant's batches to the distribution centre, which holds stock that hasn't shipped. Only the stores the lot reached are pulled; the rest are proven clear.</p>
        </div>
        <div className="relative grid gap-8 px-6 py-8 sm:px-8 md:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)] md:items-start">
          <div className="flex max-w-sm flex-col gap-3">
            <Link href="/outbreak" className="flex w-fit items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Logo className="size-8" />
              <span className="text-lg font-semibold tracking-tight">Recall Tracer</span>
            </Link>
            <p className="text-sm text-muted-foreground">Follows a contaminated lot from supplier to shelf, pulls only the stores it reached, and proves the rest are clear.</p>
          </div>
          <nav aria-label="Footer">
            <p className="mb-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">Pages</p>
            <ul className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm sm:grid-cols-3">
              {LINKS.map((l) => (
                <li key={l.href}><Link href={l.href} className="text-foreground/80 transition-colors hover:text-foreground">{l.label}</Link></li>
              ))}
            </ul>
          </nav>
          <div className="flex flex-col gap-2 text-xs text-muted-foreground md:items-end md:text-right">
            <p className="text-xs font-medium tracking-[0.16em] uppercase">Graph</p>
            <span className="inline-flex items-center gap-2 md:flex-row-reverse"><span className="size-2 rounded-full bg-chart-2 shadow-[0_0_8px_var(--chart-2)]" aria-hidden="true" />{graphLine}</span>
          </div>
        </div>
        {/* Oversized outlined wordmark in its own band, cropped at the bottom, so no text sits on top of it */}
        <div aria-hidden="true" className="relative mt-4 h-[9vw] overflow-hidden">
          <p className="pointer-events-none absolute inset-x-0 top-0 text-center text-[15vw] leading-[0.8] font-semibold tracking-tighter text-transparent select-none [-webkit-text-stroke:1px_color-mix(in_oklch,var(--foreground)_12%,transparent)]">
            Recall Tracer
          </p>
        </div>
        <div className="relative flex flex-wrap items-center justify-between gap-2 border-t border-foreground/7 px-6 py-4 text-xs text-muted-foreground sm:px-8">
          <span>Every number comes from the graph. Nothing is ever sent.</span>
          <span>Northfield Foods is a demo company · Built on FalkorDB</span>
        </div>
      </div>
    </footer>
  );
}
