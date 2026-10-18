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

// The road runs from ROAD_START to ROAD_END; the red trace takes TRACE_S seconds to cover it, so each stop pings when it arrives.
const ROAD_Y = 150, ROAD_START = 40, ROAD_END = 1560, TRACE_S = 8;
const STOPS = [
  { x: 170, label: "Supplier lot", sub: "where it starts" },
  { x: 570, label: "Plant", sub: "batches and rework" },
  { x: 1000, label: "Distribution centre", sub: "pallets and holds" },
  { x: 1420, label: "Store", sub: "pull or clear" },
];
// A faint skyline behind the stops: [x, width, height].
const SKYLINE = [[60, 40, 34], [104, 26, 52], [250, 54, 28], [330, 30, 46], [380, 44, 22], [660, 36, 40], [720, 60, 26], [800, 28, 58], [860, 48, 32], [1100, 34, 48], [1150, 58, 24], [1230, 30, 40], [1280, 44, 56], [1520, 40, 30]];

/** A delivery truck, wheels on y = 0. `lot` puts the traced lot (a pulsing red dot) in the box. */
function Truck({ lot }: { lot?: boolean }) {
  const line = "stroke-foreground/75";
  return (
    <g>
      <rect x="0" y="-38" width="58" height="29" rx="3" className={`fill-card ${line}`} strokeWidth="2" />
      <path d="M8 -30 h14 M8 -24 h22" className="stroke-foreground/25" strokeWidth="2" strokeLinecap="round" />
      <path d="M58 -31 h16 l11 13 v9 h-27 z" className={`fill-card ${line}`} strokeWidth="2" strokeLinejoin="round" />
      <path d="M63 -27 h9 l7 8 h-16 z" className="fill-foreground/20" />
      <circle cx="16" cy="-5" r="6" className={`fill-background ${line}`} strokeWidth="2" />
      <circle cx="70" cy="-5" r="6" className={`fill-background ${line}`} strokeWidth="2" />
      {lot && <circle cx="44" cy="-24" r="4.5" className="footer-lot fill-destructive" />}
    </g>
  );
}

/** The supply chain the app traces, with the trace running along it. Decorative. */
function LogisticsScene() {
  const stop = "fill-none stroke-foreground/55";
  return (
    <svg viewBox="0 0 1600 200" className="relative block h-auto w-full" aria-hidden="true">
      <g className="fill-foreground/[0.04]">
        {SKYLINE.map(([x, w, h]) => <rect key={x} x={x} y={ROAD_Y - h} width={w} height={h} rx="2" />)}
      </g>
      {/* Supplier: stacked crates */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <rect x="138" y="118" width="32" height="32" rx="2" /><path d="M138 134 h32 M154 118 v32" />
        <rect x="174" y="118" width="32" height="32" rx="2" /><path d="M174 134 h32 M190 118 v32" />
        <rect x="156" y="84" width="32" height="32" rx="2" /><path d="M156 100 h32 M172 84 v32" />
      </g>
      {/* Plant: sawtooth roof and a chimney */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <path d="M526 150 V100 L555 115 V100 L584 115 V100 L614 115 V150 Z" />
        <rect x="536" y="70" width="12" height="36" />
        <path d="M545 150 v-15 h15 v15 M578 126 h22 v11 h-22 z" />
      </g>
      <g className="fill-foreground/20">
        <circle cx="542" cy="58" r="6" className="footer-smoke" />
        <circle cx="552" cy="44" r="8" className="footer-smoke [animation-delay:-1.5s]" />
      </g>
      {/* Distribution centre: wide warehouse with a roll-up door */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <path d="M946 150 V106 L1000 80 L1054 106 V150 Z" />
        <rect x="980" y="116" width="40" height="34" />
        <path d="M980 124 h40 M980 132 h40 M980 140 h40" />
      </g>
      {/* Store: shopfront with a striped awning */}
      <g className={stop} strokeWidth="2" strokeLinejoin="round">
        <rect x="1380" y="110" width="80" height="40" />
        <path d="M1374 110 L1384 93 H1456 L1466 110 Z M1396 93 L1392 110 M1420 93 v17 M1444 93 L1448 110" />
        <rect x="1411" y="124" width="18" height="26" />
      </g>
      {/* Road, lane markings, and the trace that runs along it */}
      <path d={`M${ROAD_START} ${ROAD_Y} H${ROAD_END}`} className="stroke-foreground/30" strokeWidth="2" />
      <path d={`M${ROAD_START} ${ROAD_Y + 9} H${ROAD_END}`} className="stroke-foreground/15" strokeWidth="2" strokeDasharray="16 12" />
      <path d={`M${ROAD_START} ${ROAD_Y} H${ROAD_END}`} className="footer-trace stroke-destructive" strokeWidth="2.5" strokeLinecap="round" pathLength={1} />
      {STOPS.map((s, i) => {
        const delay = `${(((s.x - ROAD_START) / (ROAD_END - ROAD_START)) * TRACE_S).toFixed(2)}s`;
        return (
          <g key={s.label}>
            <circle cx={s.x} cy={ROAD_Y} r="5" className="fill-background stroke-foreground/60" strokeWidth="2" />
            <circle cx={s.x} cy={ROAD_Y} r="5" className="footer-ping fill-destructive" style={{ animationDelay: delay }} />
            <text x={s.x} y={ROAD_Y + 32} textAnchor="middle" className="fill-foreground font-mono text-[12px] uppercase tracking-[0.16em]">
              <tspan className="fill-muted-foreground">0{i + 1} </tspan>{s.label}
            </text>
            <text x={s.x} y={ROAD_Y + 48} textAnchor="middle" className="fill-muted-foreground text-[11px]">{s.sub}</text>
          </g>
        );
      })}
      <g transform={`translate(0 ${ROAD_Y})`}>
        <g className="footer-truck"><Truck lot /></g>
        <g className="footer-truck [animation-delay:-12s]"><Truck /></g>
      </g>
    </svg>
  );
}

/** The footer on every page: the supply-chain graphic over a large faint wordmark, then the brand, the page links and the FalkorDB status. */
export function SiteFooter({ graphLine }: { graphLine: React.ReactNode }) {
  return (
    <footer className="px-4 pt-10 pb-4">
      <div className="relative overflow-hidden rounded-3xl bg-card ring-1 ring-foreground/7">
        {/* Dot grid, faded towards the edges */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle,var(--foreground)_1px,transparent_1px)] [background-size:22px_22px] opacity-[0.07] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="relative px-4 pt-8 sm:px-8">
          <LogisticsScene />
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
