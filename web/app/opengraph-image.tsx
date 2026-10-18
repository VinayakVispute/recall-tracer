import { ImageResponse } from "next/og";

export const alt = "Recall Tracer: an agent that traces a contaminated lot to every store on a FalkorDB graph. 33 of 71 stores pulled, 38 proven clear.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The demo run's numbers, as the L-204 dashboard shows them.
const stats = [
  { n: "33 of 71", label: "stores pull product", color: "#f87171" },
  { n: "2,256", label: "units, not 7,672", color: "#fafafa" },
  { n: "38", label: "stores proven clear", color: "#fbbf24" },
];

// A small lineage: one lot, three batches, a grid of stores (red: pull, amber: cleared).
const stores = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 || i % 5 === 0 ? "#f87171" : "#fbbf24"));

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#0a0a0a", color: "#fafafa", padding: 64, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 640 }}>
            <div style={{ display: "flex", fontSize: 26, color: "#a3a3a3", letterSpacing: 2, textTransform: "uppercase" }}>Food recall agent · FalkorDB</div>
            <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 84, fontWeight: 700, marginTop: 12 }}>
              {/* The mark from app/icon.svg, on a slightly lighter tile so it reads against the background. */}
              <svg width="96" height="96" viewBox="0 0 32 32" aria-hidden="true">
                <rect width="32" height="32" rx="7" fill="#1c1c1c" />
                <path d="M10 25 V7 H16.5 A5 5 0 0 1 16.5 17 H10 M15.5 17 L21.5 23.5" fill="none" stroke="#fafafa" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="22.5" cy="24.5" r="3" fill="#f87171" />
              </svg>
              Recall Tracer
            </div>
            <div style={{ display: "flex", fontSize: 32, color: "#d4d4d4", marginTop: 16, lineHeight: 1.3 }}>
              Traces a contaminated lot to every store, and proves the rest are clean.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <div style={{ display: "flex", width: 28, height: 28, borderRadius: 14, background: "#fafafa" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {[0, 1, 2].map((b) => <div key={b} style={{ display: "flex", width: 56, height: 24, borderRadius: 6, border: "3px solid #f87171" }} />)}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", width: 172, gap: 10 }}>
              {stores.map((c, i) => <div key={i} style={{ display: "flex", width: 34, height: 18, borderRadius: 4, border: `3px solid ${c}` }} />)}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 24 }}>
          {stats.map((s) => (
            <div key={s.n} style={{ display: "flex", flexDirection: "column", flex: 1, padding: "24px 28px", borderRadius: 16, border: "2px solid #262626", borderTop: `6px solid ${s.color}`, background: "#141414" }}>
              <div style={{ display: "flex", fontSize: 56, fontWeight: 700 }}>{s.n}</div>
              <div style={{ display: "flex", fontSize: 26, color: "#a3a3a3", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
