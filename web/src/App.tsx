import { useEffect, useRef, useState } from 'react';
import type { RecallResult, TraceEvent } from '../../src/agent/run';
import type { IncidentReport, Incident } from '../../src/tools/incident';
import type { Notice } from '../../src/tools/index';
import { FlowChart, StateBars, Exposure, NetworkGraph } from './charts';
import { AgentTrace, StoreRegister, Evidence, Notices, Assessment, ScopeTable, ScopeStory, PublicNotice, fmt, shortDate, shortTime, type Step } from './panels';

const HAZARDS = [
  'Listeria monocytogenes detected in supplier finished-product testing',
  'Salmonella detected in supplier testing',
  'Undeclared milk allergen: supplier labelling error',
  'Metal fragments found in supplier lot',
];
type Status = { incident: Incident | null; hold: IncidentReport['hold'] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Rebuild the log from a saved run: each turn's notes, then its tool calls. */
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
  const [hazard, setHazard] = useState(HAZARDS[0]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RecallResult>();
  const [report, setReport] = useState<IncidentReport>();
  const [status, setStatus] = useState<Status>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<string>();
  const [view, setView] = useState<'scope' | 'flow' | 'network'>('scope');
  const [replay, setReplay] = useState<string[]>();
  const es = useRef<EventSource>(null);

  const loadNotices = async (l: string) => setNotices((await api<Notice[]>('/notices')).filter((n) => n.lot === l));
  const refreshStatus = (l: string) => api<Status>(`/incident/${l}/status`).then(setStatus).catch(() => {});

  useEffect(() => {
    api<RecallResult>('/recall/last').then(async (r) => {
      setLot(r.lot); setResult(r); setSteps(stepsFrom(r)); setView('scope');
      const rep = await api<IncidentReport>(`/incident/${r.lot}${r.add_gap_stores === false ? '?gaps=flag' : ''}`);
      setReport(rep); setStatus({ incident: rep.incident, hold: rep.hold });
      if (rep.incident?.hazard) setHazard(rep.incident.hazard);
      await loadNotices(r.lot);
    }).catch(() => {});
    return () => es.current?.close();
  }, []);

  async function trace(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResult(undefined); setReport(undefined); setStatus(undefined); setSteps([]); setNotices([]); setSelected(undefined); setStateFilter(undefined); setReplay(undefined); setView('network');
    try { await api(`/incident/${lot}/status`); } catch (err) { setError((err as Error).message); return; } // validates the lot without spending a Claude call
    setRunning(true);
    const source = new EventSource(`/recall/stream?lot=${encodeURIComponent(lot)}&hazard=${encodeURIComponent(hazard)}`);
    es.current = source;
    const on = <K extends TraceEvent['type']>(type: K, fn: (ev: Extract<TraceEvent, { type: K }>) => void) =>
      source.addEventListener(type, (m) => fn(JSON.parse((m as MessageEvent).data)));
    on('start', () => refreshStatus(lot));
    on('note', (ev) => setSteps((s) => [...s, { kind: 'note', text: ev.text }]));
    on('tool_start', (ev) => setSteps((s) => [...s, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, running: true }]));
    on('tool_end', (ev) => {
      setSteps((s) => s.map((x) => (x.kind === 'tool' && x.id === ev.call.id ? { ...x, running: false, call: ev.call } : x)));
      if (ev.call.error) return;
      if (ev.call.name === 'propose_classification' || ev.call.name === 'place_hold') refreshStatus(lot);
      // The scope appears once the agent has made its recall decision.
      if (ev.call.name === 'minimal_recall')
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
  async function confirm(cls: string, depth: string) {
    const s = await api<Status>(`/incident/${result?.lot ?? lot}/confirm`, { class: cls, depth });
    setStatus(s);
    setReport((r) => (r ? { ...r, incident: s.incident } : r));
  }

  const completed = steps.flatMap((s) => (s.kind === 'tool' && s.call && !s.call.error ? [s.name] : []));
  const graphStages = replay ?? ['start', ...completed];
  /** Plays the finished run back on the graph, one agent step every two seconds. */
  function startReplay() {
    setView('network'); setSelected(undefined);
    let i = 0;
    setReplay(['start']);
    const t = setInterval(() => {
      i++;
      if (i > completed.length) { clearInterval(t); setTimeout(() => setReplay(undefined), 1500); return; }
      setReplay(['start', ...completed.slice(0, i)]);
    }, 2000);
  }
  const incident = report?.incident ?? status?.incident ?? null;
  const hold = report?.hold ?? status?.hold;
  const canApprove = !!incident?.confirmed_at;
  const done = (name: string) => steps.some((s) => s.kind === 'tool' && s.name === name && s.call && !s.call.error);
  const approved = notices.filter((n) => n.status === 'approved').length;
  const stages = [
    ['Assessed', done('propose_classification')],
    ['Held', done('place_hold')],
    ['Traced', done('trace_forward')],
    ['Scoped', done('minimal_recall')],
    ['Verified', done('trace_backward')],
    ['Drafted', done('draft_recall_notice')],
    ['Confirmed', canApprove],
    [notices.length ? `Approved ${approved}/${notices.length}` : 'Approved', notices.length > 0 && approved === notices.length],
  ] as const;
  const store = report?.stores.find((s) => s.id === selected);
  const depth = incident?.confirmed_depth ?? incident?.depth;
  const scopedAfter = result?.finished_at && incident?.reported_at ? Math.round((Date.parse(result.finished_at) - Date.parse(incident.reported_at)) / 1000) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Recall Tracer</h1>
        <form onSubmit={trace} className="lot-form">
          <label htmlFor="lot">Supplier notice: lot</label>
          <input id="lot" value={lot} onChange={(e) => setLot(e.target.value.toUpperCase())} pattern="L-\d+" required spellCheck={false} />
          <label htmlFor="hazard" className="sr">Hazard</label>
          <select id="hazard" value={hazard} onChange={(e) => setHazard(e.target.value)}>{HAZARDS.map((h) => <option key={h}>{h}</option>)}</select>
          <button className="primary" disabled={running}>{running ? 'Working…' : 'Open incident'}</button>
        </form>
      </header>

      <section className="incident">
        <div className="incident-main">
          <h2>{report || status ? <>Lot {lot}{report ? `, ${report.lot.ingredient}` : ''}</> : running ? `Opening incident for ${lot}` : 'No incident open'}</h2>
          {report && <p className="muted">
            {fmt(report.lot.received_kg)} kg from {report.lot.supplier} ({report.lot.supplier_id}), received {shortDate(report.lot.received_at)}.
            {incident && <> Incident {incident.id}.</>}
            {scopedAfter !== undefined && <> Scope decided {scopedAfter >= 60 ? `${Math.floor(scopedAfter / 60)} min ${scopedAfter % 60} s` : `${scopedAfter} s`} after the notice was logged.</>}
          </p>}
          {incident && <p className="hazard"><b>Hazard</b> {incident.hazard}. <span className="muted">Logged {shortDate(incident.reported_at)}, {shortTime(incident.reported_at)}.</span></p>}
        </div>
        {incident && <Clock since={incident.reported_at} />}
        <ol className="stages" aria-label="Recall progress">
          {stages.map(([label, ok], i) => (
            <li key={i} className={ok ? 'ok' : running && !ok && (i === 0 || stages[i - 1][1]) ? 'active' : ''}>{label}</li>
          ))}
        </ol>
      </section>

      {error && !running && !steps.length && <p className="error banner" role="alert">{error}</p>}

      {incident && <Assessment incident={incident} running={running} onConfirm={confirm} />}
      {(hold || report) && <Kpis r={report} hold={hold} lot={lot} />}

      <div className="grid">
        <main className="main">
          {report || running || replay ? <>
            <section className="panel">
              <header className="panel-head">
                <h2>{report ? 'What left the plant' : 'Live trace'}</h2>
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={view === 'scope'} disabled={!report} onClick={() => setView('scope')}>Scope table</button>
                  <button role="tab" aria-selected={view === 'flow'} disabled={!report} onClick={() => setView('flow')}>Units flow</button>
                  <button role="tab" aria-selected={view === 'network'} onClick={() => setView('network')}>Record network</button>
                </div>
              </header>
              {report && view !== 'network' && <ScopeStory r={report} />}
              {view === 'scope' && report && <ScopeTable r={report} />}
              {view === 'flow' && report && <><FlowChart r={report} /><p className="legend"><i className="sw lot" />Bad lot <i className="sw recall" />Contains {report.lot.code} <i className="sw gap" />Delivered with no lot code. Band width is units delivered to stores; held units are not shown.</p></>}
              {view === 'network' && <>
                <NetworkGraph lot={lot} stages={graphStages} animating={running || !!replay} focus={selected} onPick={setSelected} />
                <p className="legend">
                  <i className="sw lot" />Ingredient lot <i className="sw recall" />Contains {lot} <i className="sw hold" />Held at plant or DC <i className="sw gap" />No lot code <i className="sw safe" />Cleared <i className="sw verified" />Backward check.
                  {running ? ' Each record lights up as the agent reaches it.' : ' Click a store to keep only the records that reach it.'}
                  {!running && completed.length > 0 && <button className="link-btn replay" onClick={startReplay} disabled={!!replay}>{replay ? 'Replaying…' : 'Replay the trace'}</button>}
                </p>
              </>}
            </section>
            {report && <>
              <div className="pair">
                <section className="panel"><header className="panel-head"><h2>Where it went</h2><span className="muted small">Stores by state. Click to filter the table</span></header><StateBars r={report} active={stateFilter} onPick={setStateFilter} /></section>
                <section className="panel"><header className="panel-head"><h2>Exposure</h2></header><Exposure r={report} /></section>
              </div>
              {depth === 'consumer' && <PublicNotice r={report} />}
              <StoreRegister r={report} notices={notices} onPick={setSelected} selected={selected} stateFilter={stateFilter} clearState={() => setStateFilter(undefined)} />
            </>}
          </> : (
            <section className="panel empty">
              <p>Enter the lot code and hazard from the supplier's notice and open the incident. The agent works the recall from the FalkorDB traceability graph and builds it here for you to confirm.</p>
            </section>
          )}
        </main>
        <div className="rail">
          <AgentTrace steps={steps} running={running} error={running || steps.length ? error : undefined} summary={result?.summary} meta={result?.meta} />
          {result && <Notices lot={result.lot} notices={notices} canApprove={canApprove} onApprove={approve} onPick={setSelected} />}
        </div>
      </div>

      {report && store && <Evidence r={report} store={store} notice={notices.find((n) => n.store === store.id)} canApprove={canApprove} onClose={() => setSelected(undefined)} onApprove={(id) => approve([id])} />}
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** The 24-hour window that starts when the notice is logged. */
function Clock({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Date.parse(since) + 86_400_000 - now;
  const a = Math.abs(left);
  const h = Math.floor(a / 3.6e6), m = Math.floor((a % 3.6e6) / 6e4), s = Math.floor((a % 6e4) / 1000);
  return (
    <div className={`clock ${left < 0 ? 'over' : ''}`}>
      <p className="label">24 h reporting window</p>
      <p className="value">{left < 0 ? 'Overdue ' : ''}{h}:{pad2(m)}:{pad2(s)}</p>
      <p className="foot">FDA Reportable Food Registry and FSMA 204 records request</p>
    </div>
  );
}

function Kpis({ r, hold, lot }: { r?: IncidentReport; hold?: IncidentReport['hold']; lot: string }) {
  const c = r?.counts;
  const saved = c ? 1 - c.units_to_pull / c.blanket_units : 0;
  const wait = <span className="wait">…</span>;
  return (
    <section className="kpis">
      <div className="kpi hero">
        <p className="label">Stores that must pull product</p>
        <p className="value">{c ? <>{c.targeted}<span className="of">of {c.blanket}</span></> : wait}</p>
        {r && <div className="ticks" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${r.stores.length}, 1fr)` }}>{r.stores.map((s) => <i key={s.id} className={s.status} />)}</div>}
        <p className="foot">{c ? `${c.blanket} stores stocked the ${r!.skus.length} affected products. The records clear ${c.safe} of them; a blanket recall would hit all ${c.blanket}.` : 'Tracing deliveries store by store.'}</p>
      </div>
      <div className="kpi">
        <p className="label">Units to pull from stores</p>
        <p className="value">{c ? fmt(c.units_to_pull) : wait}</p>
        <p className="foot">{c ? `A blanket recall of these products would pull ${fmt(c.blanket_units)}. Targeting saves ${Math.round(saved * 100)}%.` : 'Counted from delivery records.'}</p>
      </div>
      <div className="kpi hold">
        <p className="label">Held before it left</p>
        <p className="value">{hold ? <>{fmt(hold.totals.units)}<span className="of">units</span></> : wait}</p>
        <p className="foot">{hold ? `Unshipped product at ${hold.totals.locations} plants and DCs, plus ${hold.totals.raw_kg} kg of unused ${lot}. On hold until QA releases it.` : 'Placing the hold.'}</p>
      </div>
      <div className="kpi warn">
        <p className="label">Can't be cleared</p>
        <p className="value">{c ? <>{c.gaps}<span className="of">stores</span></> : wait}</p>
        <p className="foot">{r ? `Got ${[...new Set(r.stores.flatMap((s) => s.untracked.map((u) => u.product)))].join(', ') || 'affected product'} with no lot code on the delivery record. ${r.add_gap_stores ? 'Pulled to be safe.' : 'Flagged for review.'}` : 'Checking delivery records.'}</p>
      </div>
      <div className="kpi">
        <p className="label">Cleared by the records</p>
        <p className="value">{c ? <>{c.safe}<span className="of">stores</span></> : wait}</p>
        <p className="foot">Every lot they received was traced back to its ingredients. None contains {lot}.</p>
      </div>
    </section>
  );
}
