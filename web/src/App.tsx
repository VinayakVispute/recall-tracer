import { useEffect, useRef, useState } from 'react';
import type { RecallResult, TraceEvent } from '../../src/agent/run';
import type { IncidentReport } from '../../src/tools/incident';
import type { Notice } from '../../src/tools/index';
import { FlowChart, TileMap, ExposureStrip, NetworkGraph } from './charts';
import { AgentTrace, StoreRegister, Evidence, Notices, type Step } from './panels';

const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Rebuild the trace timeline from a saved run: each turn's notes, then its tool calls. */
function stepsFrom(r: RecallResult): Step[] {
  const notes = r.meta?.notes ?? [];
  const turns = [...new Set([...notes.map((n) => n.turn), ...r.tool_calls.map((c) => c.turn)])].sort((a, b) => a - b);
  return turns.flatMap((t) => [
    ...notes.filter((n) => n.turn === t).map((n) => ({ kind: 'note' as const, text: n.text })),
    ...r.tool_calls.filter((c) => c.turn === t).map((c) => ({ kind: 'tool' as const, id: c.id, name: c.name, input: c.input, running: false, call: c })),
  ]);
}

export function App() {
  const [lot, setLot] = useState('L-204');
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RecallResult>();
  const [report, setReport] = useState<IncidentReport>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<string>();
  const [view, setView] = useState<'flow' | 'network'>('flow');
  const es = useRef<EventSource>(null);

  const loadNotices = async (l: string) => setNotices((await api<Notice[]>('/notices')).filter((n) => n.lot === l));

  useEffect(() => {
    api<RecallResult>('/recall/last').then(async (r) => {
      setLot(r.lot); setResult(r); setSteps(stepsFrom(r));
      setReport(await api<IncidentReport>(`/incident/${r.lot}${r.add_gap_stores === false ? '?gaps=flag' : ''}`));
      await loadNotices(r.lot);
    }).catch(() => {});
    return () => es.current?.close();
  }, []);

  async function trace(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResult(undefined); setReport(undefined); setSteps([]); setNotices([]); setSelected(undefined); setStateFilter(undefined);
    try { await api(`/incident/${lot}`); } catch (err) { setError((err as Error).message); return; } // validates the lot without spending a Claude call
    setRunning(true);
    const source = new EventSource(`/recall/stream?lot=${encodeURIComponent(lot)}`);
    es.current = source;
    const on = <K extends TraceEvent['type']>(type: K, fn: (ev: Extract<TraceEvent, { type: K }>) => void) =>
      source.addEventListener(type, (m) => fn(JSON.parse((m as MessageEvent).data)));
    on('note', (ev) => setSteps((s) => [...s, { kind: 'note', text: ev.text }]));
    on('tool_start', (ev) => setSteps((s) => [...s, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, running: true }]));
    on('tool_end', (ev) => {
      setSteps((s) => s.map((x) => (x.kind === 'tool' && x.id === ev.call.id ? { ...x, running: false, call: ev.call } : x)));
      // The dashboard appears once the agent has made its recall decision.
      if (ev.call.name === 'minimal_recall' && !ev.call.error)
        api<IncidentReport>(`/incident/${lot}${(ev.call.input as any)?.add_gap_stores === false ? '?gaps=flag' : ''}`).then(setReport);
    });
    on('done', (ev) => { setResult(ev.result); setRunning(false); source.close(); loadNotices(lot); });
    let finished = false;
    source.addEventListener('done', () => (finished = true));
    source.addEventListener('error', (m) => {
      if (finished) return;
      const data = (m as MessageEvent).data;
      setError(data ? JSON.parse(data).message : 'Lost connection to the agent. Check the API server and try again.');
      setRunning(false); source.close();
    });
  }

  async function approve(stores: string[]) {
    await api('/notices/approve', { stores });
    await loadNotices(result?.lot ?? lot);
  }

  const done = (name: string) => steps.some((s) => s.kind === 'tool' && s.name === name && s.call && !s.call.error);
  const approved = notices.filter((n) => n.status === 'approved').length;
  const stages = [
    ['Traced', done('trace_forward')],
    ['Gaps decided', done('minimal_recall')],
    ['Safe stores verified', done('trace_backward')],
    ['Notices drafted', done('draft_recall_notice')],
    [notices.length ? `Approved ${approved}/${notices.length}` : 'Approved', notices.length > 0 && approved === notices.length],
  ] as const;
  const store = report?.stores.find((s) => s.id === selected);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Recall Tracer</h1>
        <form onSubmit={trace} className="lot-form">
          <label htmlFor="lot">Contaminated lot</label>
          <input id="lot" value={lot} onChange={(e) => setLot(e.target.value.toUpperCase())} pattern="L-\d+" required spellCheck={false} />
          <button className="primary" disabled={running}>{running ? 'Tracing…' : 'Trace'}</button>
        </form>
      </header>

      <section className="incident">
        <div>
          <h2>{report ? <>Lot {report.lot.code}, {report.lot.ingredient}</> : running ? `Tracing ${lot}` : 'No incident open'}</h2>
          {report && <p className="muted">
            Supplier {report.lot.supplier} ({report.lot.supplier_id}), received {shortDate(report.lot.received_at)}
            {result?.finished_at && <>. Traced {new Date(result.finished_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}
          </p>}
        </div>
        <ol className="stages" aria-label="Recall progress">
          {stages.map(([label, ok], i) => (
            <li key={i} className={ok ? 'ok' : running && !ok && (i === 0 || stages[i - 1][1]) ? 'active' : ''}>{label}</li>
          ))}
        </ol>
      </section>

      {error && !running && !steps.length && <p className="error banner" role="alert">{error}</p>}

      {report && <Kpis r={report} />}

      <div className="grid">
        <main className="main">
          {report ? <>
            <section className="panel">
              <header className="panel-head">
                <h2>How {report.lot.code} spread</h2>
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={view === 'flow'} onClick={() => setView('flow')}>Units flow</button>
                  <button role="tab" aria-selected={view === 'network'} onClick={() => setView('network')}>Record network</button>
                </div>
              </header>
              {view === 'flow'
                ? <><FlowChart r={report} /><p className="legend"><i className="sw lot" />Bad lot <i className="sw recall" />Contains {report.lot.code} <i className="sw gap" />Shipped with no lot code. Band width is units shipped to stores.</p></>
                : <><NetworkGraph lot={report.lot.code} focus={selected} onPick={setSelected} /><p className="legend">Every record in the graph. Click a store to keep only the records that reach it.</p></>}
            </section>
            <div className="pair">
              <section className="panel"><header className="panel-head"><h2>Where it went</h2><span className="muted small">Click a state to filter stores</span></header><TileMap r={report} onPick={setStateFilter} /></section>
              <section className="panel"><header className="panel-head"><h2>Exposure window</h2></header><ExposureStrip r={report} /></section>
            </div>
            <StoreRegister r={report} notices={notices} onPick={setSelected} selected={selected} stateFilter={stateFilter} clearState={() => setStateFilter(undefined)} />
          </> : (
            <section className="panel empty">
              {running
                ? <p>The agent is tracing {lot} through batches, rework and shipments. The dashboard opens as soon as it has decided the recall.</p>
                : <p>Enter the lot code from the supplier's alert and press Trace. The agent follows the lot through the FalkorDB graph and builds the recall here.</p>}
            </section>
          )}
        </main>
        <div className="rail">
          <AgentTrace steps={steps} running={running} error={running || steps.length ? error : undefined} summary={result?.summary} meta={result?.meta} />
          {result && <Notices lot={result.lot} notices={notices} onApprove={approve} onPick={setSelected} />}
        </div>
      </div>

      {report && store && <Evidence r={report} store={store} notice={notices.find((n) => n.store === store.id)} onClose={() => setSelected(undefined)} onApprove={(id) => approve([id])} />}
    </div>
  );
}

function Kpis({ r }: { r: IncidentReport }) {
  const c = r.counts;
  const rework = r.lineage.filter((e) => e.type === 'REWORKED_INTO');
  const saved = 1 - c.units_to_pull / c.blanket_units;
  return (
    <section className="kpis">
      <div className="kpi hero">
        <p className="label">Stores to recall</p>
        <p className="value">{c.targeted}<span className="of">of {c.blanket}</span></p>
        <div className="ticks" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${r.stores.length}, 1fr)` }}>{r.stores.map((s) => <i key={s.id} className={s.status} />)}</div>
        <p className="foot">{c.blanket} stores got these products. A blanket recall would pull all of them.</p>
      </div>
      <div className="kpi">
        <p className="label">Units to pull</p>
        <p className="value">{fmt(c.units_to_pull)}</p>
        <p className="foot">A blanket recall pulls {fmt(c.blanket_units)}. Targeting saves {Math.round(saved * 100)}%.</p>
      </div>
      <div className="kpi">
        <p className="label">Spread</p>
        <p className="value">{c.product_lots}<span className="of">product lots</span></p>
        <p className="foot">{c.batches} batches, {r.skus.length} products{rework.length ? `. Rework ${rework.map((e) => `${e.source}→${e.target}`).join(', ')} carried it on` : ''}.</p>
      </div>
      <div className="kpi warn">
        <p className="label">Can't be cleared</p>
        <p className="value">{c.gaps}<span className="of">stores</span></p>
        <p className="foot">Got {[...new Set(r.stores.flatMap((s) => s.untracked.map((u) => u.product)))].join(', ') || 'affected product'} with no lot code. {r.add_gap_stores ? 'Added to the recall.' : 'Flagged for review.'}</p>
      </div>
      <div className="kpi">
        <p className="label">Proven safe</p>
        <p className="value">{c.safe}<span className="of">stores</span></p>
        <p className="foot">Every lot they hold was traced back to its ingredients. None contains {r.lot.code}.</p>
      </div>
    </section>
  );
}
