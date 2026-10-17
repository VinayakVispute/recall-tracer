import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { RecallResult } from '../../src/agent/run';
import type { Notice } from '../../src/tools/index';

type Elements = { nodes: { data: { id: string; kind: string } }[]; edges: { data: { id: string; source: string; target: string; kind: string } }[] };

const COLOR: Record<string, string> = {
  lot: '#c8231e', batch: '#e8771a', 'product-lot': '#e8771a', 'store-affected': '#e8771a',
  product: '#f2c230', 'store-gap': '#f2c230', 'store-safe': '#a9b1ae', 'product-lot-clean': '#c9cfcc',
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function App() {
  const [lot, setLot] = useState('L-204');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RecallResult>();
  const [graph, setGraph] = useState<Elements>();
  const [notices, setNotices] = useState<Notice[]>([]);

  async function show(r: RecallResult) {
    setLot(r.lot);
    setResult(r);
    const [g, n] = await Promise.all([api<Elements>(`/graph/${r.lot}`), api<Notice[]>('/notices')]);
    setGraph(g);
    setNotices(n.filter((x) => x.lot === r.lot));
  }

  useEffect(() => { api<RecallResult>('/recall/last').then(show).catch(() => {}); }, []);

  async function trace(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setResult(undefined); setGraph(undefined);
    try {
      await show(await api<RecallResult>('/recall', { lot }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approveAll() {
    await api('/notices/approve', { stores: notices.filter((n) => n.status === 'pending_approval').map((n) => n.store) });
    setNotices((await api<Notice[]>('/notices')).filter((n) => n.lot === lot));
  }

  const pending = notices.filter((n) => n.status === 'pending_approval').length;

  return (
    <main>
      <header className="masthead">
        <h1>Recall Tracer</h1>
        <form onSubmit={trace} className="lot-form">
          <label htmlFor="lot">Contaminated lot</label>
          <input id="lot" value={lot} onChange={(e) => setLot(e.target.value.toUpperCase())} pattern="L-\d+" required spellCheck={false} />
          <button disabled={busy}>{busy ? 'Tracing…' : 'Trace'}</button>
        </form>
      </header>

      {busy && <p className="status" role="status">The agent is following {lot} through batches, rework and shipments. This takes about half a minute.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!result && !busy && !error && <p className="status">Enter the lot code from the supplier's alert and press Trace.</p>}

      {result && (
        <>
          <Comparison r={result} />
          <p className="summary">{result.summary}</p>

          <section className="graph-wrap" aria-label="Trace graph">
            <Graph elements={graph} />
            <p className="hint">Click a store to see the records that reach it.</p>
            <ul className="legend">
              <li><i style={{ background: COLOR.lot }} />Bad lot</li>
              <li><i style={{ background: COLOR.batch }} />Affected (orange lines: lot-coded path)</li>
              <li><i style={{ background: COLOR['store-gap'] }} />Gap: shipped with no lot code (dashed)</li>
              <li><i style={{ background: COLOR['store-safe'] }} />Proven safe, with the clean lots it received</li>
            </ul>
          </section>

          <section className="lists">
            <div>
              <h2>Affected <span>{result.affected.length}</span></h2>
              <ul>{result.affected.map((a) => (
                <li key={a.store}><b>{a.store}</b>{a.path.map((p) => <span className="path" key={p.join()}>{p.join(' › ')}</span>)}</li>
              ))}</ul>
            </div>
            <div>
              <h2>Gaps <span>{result.gaps.length}</span></h2>
              <ul>{result.gaps.map((g) => (
                <li key={g.store} className="gap"><b>{g.store}</b>{g.added_to_recall ? ' added to recall' : ' flagged only'}<span className="path">{g.reason}</span></li>
              ))}</ul>
            </div>
            <div>
              <h2>Safe <span>{result.safe.length}</span></h2>
              <ul>{result.safe.map((s) => (
                <li key={s.store}><b>{s.store}</b><span className="path">Checked {s.received_lots.map((l) => l.lot).join(', ')}: none trace to {result.lot}</span></li>
              ))}</ul>
            </div>
          </section>

          <section className="steps">
            <h2>How the agent got here</h2>
            <ol>{result.tool_calls.map((c, i) => (
              <li key={i}><code>{c.name}</code> {c.ms} ms{c.error && ' (failed)'}</li>
            ))}</ol>
          </section>

          <section className="notices">
            <div className="notices-head">
              <h2>Draft notices <span>{notices.length}</span></h2>
              <div className="actions">
                <a href={`/export/${result.lot}.csv`} download>Download FDA shipping CSV</a>
                <button onClick={approveAll} disabled={!pending}>{pending ? `Approve all ${pending}` : 'All approved'}</button>
              </div>
            </div>
            <p className="note">Approving marks notices ready. Nothing is sent from here.</p>
            <ul>{notices.map((n) => (
              <li key={n.store} data-status={n.status}>
                <b>{n.name}</b> {n.city}
                <span className="badge">{n.status === 'approved' ? 'Approved' : 'Awaiting approval'}</span>
                <span className="path">{n.reason}</span>
              </li>
            ))}</ul>
          </section>
        </>
      )}
    </main>
  );
}

/** One tick per store that got an affected SKU: the blanket recall. Coloured ticks are the targeted recall. */
function Comparison({ r }: { r: RecallResult }) {
  const ticks = [
    ...r.affected.map(() => 'affected'),
    ...r.gaps.map((g) => (g.added_to_recall ? 'gap' : 'gap-flag')),
    ...r.safe.map(() => 'safe'),
  ];
  return (
    <section className="compare" aria-label="Blanket versus targeted recall">
      <div className="figures">
        <p><strong className="struck">{r.counts.blanket}</strong> stores in a blanket recall</p>
        <p><strong>{r.counts.targeted}</strong> stores in the targeted recall</p>
        <p><strong>{r.units_to_pull.toLocaleString()}</strong> units to pull</p>
        <p><strong className="quiet">{r.counts.safe}</strong> stores proven safe</p>
      </div>
      <div className="ticks" aria-hidden="true">{ticks.map((t, i) => <i key={i} className={t} />)}</div>
    </section>
  );
}

function Graph({ elements }: { elements?: Elements }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!elements || !ref.current) return;
    const cy = cytoscape({
      container: ref.current,
      elements: [...elements.nodes, ...elements.edges],
      layout: { name: 'preset', positions: layered(elements) as never },
      style: [
        { selector: 'node', style: { 'background-color': (n: any) => COLOR[n.data('kind')] ?? '#888', width: 12, height: 12, label: 'data(id)', 'font-size': 9, 'font-family': 'IBM Plex Sans', color: '#3a4441', 'text-valign': 'bottom', 'text-margin-y': 2 } },
        { selector: 'node[kind = "lot"]', style: { width: 26, height: 26, 'font-size': 11, 'font-weight': 600 } },
        { selector: 'edge', style: { width: 1, 'line-color': '#d4d9d6', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#d4d9d6', 'arrow-scale': 0.5 } },
        { selector: 'edge[kind = "affected"]', style: { 'line-color': '#e8771a', 'target-arrow-color': '#e8771a', width: 1.4 } },
        { selector: 'edge[kind = "untracked"]', style: { 'line-color': '#d9a514', 'target-arrow-color': '#d9a514', 'line-style': 'dashed', width: 1.4 } },
        { selector: '.dim', style: { opacity: 0.12 } },
      ],
      userZoomingEnabled: false, // keep the mouse wheel for page scroll
    });
    if (import.meta.env.DEV) (window as unknown as { cy: typeof cy }).cy = cy; // lets the demo recorder click nodes
    // Click a node to see only the records that lead to it; click the background to reset.
    cy.on('tap', (e) => {
      cy.elements().removeClass('dim');
      if (e.target === cy) return;
      cy.elements().not(e.target.predecessors().add(e.target)).addClass('dim');
    });
    return () => cy.destroy();
  }, [elements]);
  return <div className="graph" ref={ref} />;
}

const ROW = 30, COL = 260;

/** Columns: lot → batches (rework one step right) → product lots → stores in four sub-columns. */
function layered({ nodes, edges }: Elements) {
  const reworked = new Set(edges.filter((e) => e.data.source.startsWith('B-') && e.data.target.startsWith('B-')).map((e) => e.data.target));
  const order = ['store-affected', 'store-gap', 'store-safe'];
  const stores = nodes.filter((n) => n.data.kind.startsWith('store')).sort((a, b) => order.indexOf(a.data.kind) - order.indexOf(b.data.kind));
  const col = (kind: string, id: string) =>
    kind === 'lot' ? 0 : kind === 'batch' ? (reworked.has(id) ? 1.6 : 1) : kind.startsWith('product') ? 2.4 : 3.4;
  const pos: Record<string, { x: number; y: number }> = {};
  const rows: Record<number, number> = {};
  for (const n of nodes.filter((n) => !n.data.kind.startsWith('store'))) {
    const c = col(n.data.kind, n.data.id);
    rows[c] = (rows[c] ?? 0) + 1;
    pos[n.data.id] = { x: c * COL, y: rows[c] * ROW };
  }
  const perCol = Math.ceil(stores.length / 4);
  stores.forEach((n, i) => { pos[n.data.id] = { x: 3.4 * COL + Math.floor(i / perCol) * 110, y: (i % perCol + 1) * ROW }; });
  // centre short columns against the tallest
  const height = Math.max(perCol, ...Object.values(rows)) * ROW;
  for (const n of nodes.filter((n) => !n.data.kind.startsWith('store'))) {
    const c = col(n.data.kind, n.data.id);
    pos[n.data.id].y += (height - rows[c] * ROW) / 2;
  }
  return pos;
}
