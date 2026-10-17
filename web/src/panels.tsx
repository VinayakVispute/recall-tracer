import { useMemo, useState } from 'react';
import type { IncidentReport, Incident } from '../../src/tools/incident';
import type { ToolCall } from '../../src/agent/run';
import type { Notice } from '../../src/tools/index';

type Report = IncidentReport;
type Store = Report['stores'][number];
export const fmt = (n: number) => n.toLocaleString();
export const shortDate = (iso: string) => (iso ? new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
export const shortTime = (iso: string) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
export const STATUS_LABEL = { recall: 'Pull product', gap: 'Pull, no record', safe: 'Cleared' } as const;
export const chainOf = (name: string) => name.split(' #')[0];

export function StatusBadge({ s }: { s: Store['status'] }) {
  return <span className={`badge ${s}`}>{STATUS_LABEL[s]}</span>;
}

/** How a product lot came to contain the bad lot, in words, from the lineage edges. */
export function via(r: Report, batch: string) {
  const used = r.lineage.find((e) => e.type === 'USED_IN' && e.target === batch);
  if (used) return `${used.qty_kg} kg of ${r.lot.code} used in ${batch}`;
  const rw = r.lineage.find((e) => e.type === 'REWORKED_INTO' && e.target === batch);
  return rw ? `${rw.qty_kg} kg of leftovers from ${rw.source} reworked into ${batch}` : `made in ${batch}`;
}

// --- Hazard assessment (agent proposes, coordinator confirms) ---------------

const CLASS_TEXT: Record<string, string> = {
  I: 'reasonable probability of serious health consequences or death',
  II: 'temporary or medically reversible health effects',
  III: 'not likely to cause adverse health consequences',
};
const DEPTH_TEXT: Record<string, string> = {
  consumer: 'product is on shelves, the public must be told',
  retail: 'stores pull it, no public notice',
  wholesale: 'still in distribution, pull from DCs',
};

export function Assessment({ incident, running, onConfirm }: { incident: Incident; running: boolean; onConfirm: (cls: string, depth: string) => void }) {
  const [cls, setCls] = useState<string>();
  const [depth, setDepth] = useState<string>();
  if (!incident.class) return (
    <section className="panel assessment pending">
      <h2>Hazard assessment</h2>
      <p className="muted">{running ? 'The agent is assessing the hazard and will propose a recall class and depth.' : 'Not assessed yet.'}</p>
    </section>
  );
  const c = cls ?? incident.class, d = depth ?? incident.depth!;
  if (incident.confirmed_at) return (
    <section className="panel assessment confirmed">
      <div>
        <h2>Class {incident.confirmed_class}, {incident.confirmed_depth}-level recall</h2>
        <p className="muted">Confirmed by the coordinator at {shortTime(incident.confirmed_at)}{incident.confirmed_class !== incident.class || incident.confirmed_depth !== incident.depth ? `, changed from the agent's proposal of Class ${incident.class}, ${incident.depth}` : ', as the agent proposed'}. {CLASS_TEXT[incident.confirmed_class!]}; {DEPTH_TEXT[incident.confirmed_depth!]}.</p>
      </div>
    </section>
  );
  return (
    <section className="panel assessment">
      <div>
        <p className="label">Hazard assessment, proposed by the agent</p>
        <h2>Class {incident.class}, {incident.depth}-level recall</h2>
        <p className="rationale">{incident.rationale}</p>
      </div>
      <form className="confirm" onSubmit={(e) => { e.preventDefault(); onConfirm(c, d); }}>
        <label>Class
          <select value={c} onChange={(e) => setCls(e.target.value)}>{['I', 'II', 'III'].map((k) => <option key={k} value={k}>Class {k}: {CLASS_TEXT[k]}</option>)}</select>
        </label>
        <label>Depth
          <select value={d} onChange={(e) => setDepth(e.target.value)}>{['consumer', 'retail', 'wholesale'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}: {DEPTH_TEXT[k]}</option>)}</select>
        </label>
        <button className="primary">{c === incident.class && d === incident.depth ? 'Confirm' : 'Confirm with changes'}</button>
        <p className="muted small">Notices can be approved only after this. FDA assigns the final class; this is the firm's assessment.</p>
      </form>
    </section>
  );
}

// --- Scope table: one row per affected product lot --------------------------

export function ScopeTable({ r }: { r: Report }) {
  const lots = r.product_lots.filter((p) => p.affected).sort((a, b) => a.id.localeCompare(b.id));
  const batch = (id: string) => r.batches.find((b) => b.id === id);
  const sum = (k: 'units' | 'shipped' | 'held') => lots.reduce((n, p) => n + p[k], 0);
  return (
    <div className="table-scroll">
      <table className="scope">
        <thead><tr><th>Product lot</th><th>Product</th><th>Made</th><th>Contains {r.lot.code} via</th><th>Best by</th><th className="num">Made</th><th className="num">Shipped to stores</th><th className="num">On hold</th></tr></thead>
        <tbody>
          {lots.map((p) => {
            const b = batch(p.batch);
            return (
              <tr key={p.id}>
                <td><b>{p.id}</b></td>
                <td>{p.product}<span className="sub">UPC {p.upc}</span></td>
                <td>{shortDate(p.produced_at)}<span className="sub">{b?.site.split(',')[0]}</span></td>
                <td className={via(r, p.batch).includes('rework') ? 'rework-cell' : ''}>{via(r, p.batch)}</td>
                <td>{shortDate(p.best_by)}</td>
                <td className="num">{fmt(p.units)}</td>
                <td className="num">{fmt(p.shipped)}<span className="sub">{p.stores} stores</span></td>
                <td className="num">{fmt(p.held)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><td colSpan={5}>{lots.length} product lots</td><td className="num">{fmt(sum('units'))}</td><td className="num">{fmt(sum('shipped'))}</td><td className="num">{fmt(sum('held'))}</td></tr></tfoot>
      </table>
    </div>
  );
}

/** One paragraph that reads the lineage out loud. */
export function ScopeStory({ r }: { r: Report }) {
  const used = r.lineage.filter((e) => e.type === 'USED_IN');
  const rework = r.lineage.filter((e) => e.type === 'REWORKED_INTO');
  const lots = r.product_lots.filter((p) => p.affected);
  const hit = r.stores.filter((s) => s.status !== 'safe');
  const states = new Set(hit.map((s) => s.region));
  const sites = [...new Set(r.batches.map((b) => b.site.split(',')[0]))];
  const kg = used.reduce((n, e) => n + (e.qty_kg ?? 0), 0);
  return (
    <p className="story">
      <b>{kg} kg of {r.lot.code}</b> went into {used.length} batches ({used.map((e) => e.target).join(', ')}) at {sites.join(' and ')}.
      {rework.map((e) => <span key={e.target}> Then <b>{e.qty_kg} kg of leftovers from {e.source} were reworked into {e.target}</b>, which carried it into one more lot.</span>)}
      {' '}Those batches made {lots.length} product lots of {r.skus.map((s) => s.product).join(', ')}.
      {' '}<b>{fmt(lots.reduce((n, p) => n + p.shipped, 0))} units reached {hit.filter((s) => s.status === 'recall').length} stores</b> in {states.size} states{hit.some((s) => s.status === 'gap') ? <>, plus {fmt(hit.flatMap((s) => s.untracked).reduce((n, u) => n + u.units, 0))} units delivered to {hit.filter((s) => s.status === 'gap').length} stores with no lot code</> : null}; {fmt(lots.reduce((n, p) => n + p.held, 0))} units never left and are on hold.
    </p>
  );
}

// --- Public notice facts ------------------------------------------------------

export function PublicNotice({ r }: { r: Report }) {
  const hit = r.stores.filter((s) => s.status !== 'safe');
  const chains = [...new Set(hit.map((s) => chainOf(s.name)))].sort();
  const states = [...new Set(hit.map((s) => s.region))].sort();
  const lots = r.product_lots.filter((p) => p.affected);
  return (
    <section className="panel facts-panel">
      <header className="panel-head"><h2>Public notice facts</h2><span className="muted small">Consumer-level recall</span></header>
      <p className="muted small">What the press release must list so shoppers can check their fridge. Read from the graph; nothing is published from here.</p>
      <table className="facts-table">
        <thead><tr><th>Product</th><th>UPC</th><th>Lot codes on pack</th><th>Best by</th></tr></thead>
        <tbody>
          {r.skus.map((s) => {
            const ls = lots.filter((p) => p.sku === s.sku);
            const bb = ls.map((p) => p.best_by).sort();
            return <tr key={s.sku}><td>{s.product}</td><td className="mono">{s.upc}</td><td className="mono">{ls.map((p) => p.id).join(', ')}</td><td>{bb.length ? `${shortDate(bb[0])}${bb.length > 1 && bb.at(-1) !== bb[0] ? ` to ${shortDate(bb.at(-1)!)}` : ''}` : ''}</td></tr>;
          })}
        </tbody>
      </table>
      <p className="small">Sold at {chains.join(', ')} stores in {states.join(', ')}. Reason: {r.incident?.hazard ?? 'contamination'}. Consumers should not eat the product and may return it for a refund.</p>
    </section>
  );
}

// --- Investigation log ------------------------------------------------------

export type Step =
  | { kind: 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; running: boolean; call?: ToolCall };

const TITLE: Record<string, string> = {
  propose_classification: 'Hazard assessment',
  place_hold: 'Hold at plants and DCs',
  trace_forward: 'Forward trace',
  coverage_gaps: 'Delivery record check',
  unaffected_stores: 'Clearance check',
  minimal_recall: 'Scope decision',
  trace_backward: 'Backward check on cleared stores',
  draft_recall_notice: 'Store notices drafted',
};
const DOING: Record<string, string> = {
  propose_classification: 'Recording the proposed class and depth',
  place_hold: 'Finding unshipped inventory and marking it held',
  trace_forward: 'Following the lot through batches, rework and deliveries',
  coverage_gaps: 'Looking for deliveries with no lot code',
  minimal_recall: 'Combining the traces into a decision',
  trace_backward: 'Walking every cleared lot back to its ingredients',
  draft_recall_notice: 'Writing one draft per store',
};

/** Big inputs (33 notices, 60 product lots) are condensed so the log stays readable. */
function brief(input: any) {
  if (!input || typeof input !== 'object') return JSON.stringify(input);
  return Object.entries(input).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} items` : JSON.stringify(v)}`).join(', ');
}

export function AgentTrace({ steps, running, meta, summary, error }: {
  steps: Step[]; running: boolean; error?: string; summary?: string;
  meta?: { model: string; ms: number; turns: number; input_tokens: number; output_tokens: number };
}) {
  const [open, setOpen] = useState<number>();
  let n = 0;
  return (
    <section className="panel trace" aria-live="polite">
      <header className="panel-head"><h2>Investigation log</h2>{running && <span className="live">Running</span>}</header>
      <p className="muted small intro">Every step the agent took, in order, with the graph query behind it. This is the audit trail.</p>
      {!steps.length && !running && <p className="muted">Open an incident to start. Each step appears here as it happens.</p>}
      <ol className="steps">
        {steps.map((s, i) => s.kind === 'note' ? (
          <li key={i} className="note">{s.text}</li>
        ) : (
          <li key={s.id ?? i} className={`step ${s.running ? 'running' : ''} ${s.call?.error ? 'failed' : ''}`}>
            <span className="step-n">{++n}</span>
            <div className="step-body">
              <div className="step-top"><b>{TITLE[s.name] ?? s.name}</b><span className="ms">{s.call ? `${s.call.ms} ms` : '…'}</span></div>
              <p className="step-sum">{s.running ? DOING[s.name] ?? 'Querying the graph' : s.call?.summary}</p>
              {s.name === 'minimal_recall' && s.call && (
                <p className="decision">Policy applied: stores with no delivery record are {(s.input as any)?.add_gap_stores === false ? 'flagged for the coordinator' : 'pulled too'}, because the records can't clear them.</p>
              )}
              {s.name === 'propose_classification' && s.call && (
                <p className="decision">A proposal. The coordinator confirms or changes it in the assessment card above.</p>
              )}
              {s.call && (
                <button className="link-btn" aria-expanded={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
                  {open === i ? 'Hide' : `Tool ${s.name}, show input and Cypher`}
                </button>
              )}
              {open === i && s.call && (
                <div className="step-detail">
                  <p><b>Input</b> {brief(s.input)}</p>
                  {(s.call.cypher ?? []).map((q, j) => <pre key={j}>{q.trim()}</pre>)}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {error && <p className="error" role="alert">{error}</p>}
      {summary && <div className="agent-summary"><h3>Agent's summary</h3><p>{summary.replace(/\*\*|__|^#+\s*/gm, '')}</p></div>}
      {meta && <p className="meta">{meta.model}, {meta.turns} turns, {(meta.ms / 1000).toFixed(1)} s, {fmt(meta.input_tokens + meta.output_tokens)} tokens</p>}
    </section>
  );
}

// --- Store register ---------------------------------------------------------

type Filter = 'all' | Store['status'];

export function StoreRegister({ r, notices, onPick, selected, stateFilter, clearState }: {
  r: Report; notices: Notice[]; onPick: (id: string) => void; selected?: string; stateFilter?: string; clearState: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const noticeOf = useMemo(() => new Map(notices.map((n) => [n.store, n.status])), [notices]);
  const count = (f: Filter) => r.stores.filter((s) => f === 'all' || s.status === f).length;
  const rows = r.stores.filter((s) =>
    (filter === 'all' || s.status === filter) && (!stateFilter || s.region === stateFilter) &&
    (!q || `${s.id} ${s.name} ${s.city} ${s.shipments.map((x) => x.lot).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <section className="panel register">
      <header className="panel-head">
        <div><h2>Store decisions <span className="count">{rows.length}</span></h2><p className="muted small">Every store that stocked the affected products, and what the records say. Click a row for the evidence.</p></div>
        <div className="filters" role="group" aria-label="Filter stores">
          {(['all', 'recall', 'gap', 'safe'] as Filter[]).map((f) => (
            <button key={f} className={`chip ${f}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : STATUS_LABEL[f]} {count(f)}
            </button>
          ))}
          {stateFilter && <button className="chip" aria-pressed onClick={clearState}>{stateFilter} ✕</button>}
          <input type="search" placeholder="Search store, city or lot" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stores" />
        </div>
      </header>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Decision</th><th>Store</th><th>Location</th><th>Received</th><th className="num">Units to pull</th><th>Last delivery</th><th>Notice</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={selected === s.id ? 'selected' : ''} onClick={() => onPick(s.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(s.id)}>
                <td><StatusBadge s={s.status} /></td>
                <td><b>{s.name}</b><span className="sub">{s.id}</span></td>
                <td>{s.city}, {s.region}</td>
                <td><div className="lots">
                  {s.shipments.map((x) => <span key={x.lot} className={`lot-chip ${x.affected ? 'bad' : ''}`} title={`${x.units} units of ${x.product}, ${shortDate(x.shipped_at)}`}>{x.lot}</span>)}
                  {s.untracked.map((u, i) => <span key={i} className="lot-chip unknown" title={`${u.units} units of ${u.product}, ${shortDate(u.shipped_at)}`}>{u.product}, no lot code</span>)}
                </div></td>
                <td className="num">{s.units_at_risk ? fmt(s.units_at_risk) : '0'}</td>
                <td>{shortDate(s.last_shipped)}</td>
                <td>{noticeOf.get(s.id) === 'approved' ? <span className="ok">Approved</span> : noticeOf.get(s.id) ? 'Draft' : <span className="muted">None needed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Evidence drawer --------------------------------------------------------

export function Evidence({ r, store, notice, canApprove, onClose, onApprove }: {
  r: Report; store: Store; notice?: Notice; canApprove: boolean; onClose: () => void; onApprove: (id: string) => void;
}) {
  const edge = (s: string, t: string) => r.lineage.find((e) => e.source === s && e.target === t);
  const batch = (id: string) => r.batches.find((b) => b.id === id);
  const pl = (id: string) => r.product_lots.find((p) => p.id === id);
  const bad = store.shipments.filter((s) => s.affected), clean = store.shipments.filter((s) => !s.affected);
  const lead = store.status === 'recall'
    ? <>Pull product. {store.name} received {bad.map((s) => `${s.units} units of ${s.product} (${s.lot}) on ${shortDate(s.shipped_at)}`).join(' and ')}. {bad.length > 1 ? 'Both lots contain' : `${bad[0]?.lot} contains`} {r.lot.code}{bad.some((s) => via(r, pl(s.lot)?.batch ?? '').includes('rework')) ? ', through rework' : ''}.</>
    : store.status === 'gap'
      ? <>Pull to be safe. {store.name} received {store.untracked.map((u) => `${u.units} units of ${u.product} on ${shortDate(u.shipped_at)}`).join(' and ')} with no lot code on the delivery record, so the records can't show whether it came from a contaminated lot.</>
      : <>Cleared. Every lot {store.name} received was traced back to its ingredients: {clean.map((s) => s.lot).join(', ')}. None contains {r.lot.code}.</>;
  return (
    <aside className="drawer" aria-label={`Evidence for ${store.name}`}>
      <header className="drawer-head">
        <div><StatusBadge s={store.status} /><h2>{store.name}</h2><p className="muted">{store.id}, {store.city}, {store.region}</p></div>
        <button className="close" onClick={onClose} aria-label="Close evidence">✕</button>
      </header>
      <p className={`lead ${store.status}`}>{lead}</p>

      {store.status === 'recall' && <>
        <h3>The records behind it</h3>
        {store.paths.map((p) => {
          const ship = bad.find((s) => s.lot === p.at(-2));
          return (
            <ol key={p.join()} className="chain">
              <li><b>{r.lot.code}</b>, {r.lot.ingredient}<span>Supplied by {r.lot.supplier}, received {shortDate(r.lot.received_at)}</span></li>
              {p.slice(1, -1).map((id, i) => {
                const e = edge(p[i], id);
                if (id.startsWith('B-')) {
                  const b = batch(id);
                  return <li key={id} className={e?.type === 'REWORKED_INTO' ? 'rework' : ''}>
                    <b>Batch {id}</b>{e?.type === 'REWORKED_INTO' ? `, reused ${e.qty_kg} kg of ${p[i]} leftovers` : `, used ${e?.qty_kg} kg`}
                    <span>{b?.site}, produced {shortDate(b?.produced_at ?? '')}</span>
                  </li>;
                }
                const x = pl(id);
                return <li key={id}><b>Lot {id}</b>, {x?.product}<span>{fmt(e?.units ?? 0)} units made from {p[i]}, best by {shortDate(x?.best_by ?? '')}</span></li>;
              })}
              <li className="end"><b>Delivered {ship?.units} units</b> to this store<span>{shortDate(ship?.shipped_at ?? '')}</span></li>
            </ol>
          );
        })}
      </>}

      {store.status === 'gap' && <>
        <h3>The missing record</h3>
        {store.untracked.map((u, i) => {
          const suspects = r.product_lots.filter((p) => p.sku === u.sku && p.affected).map((p) => p.id);
          return <div key={i} className="gap-card">
            <p><b>{u.units} units of {u.product}</b> arrived {shortDate(u.shipped_at)}. The delivery record has no lot code.</p>
            <p>Lots of {u.product} that contain {r.lot.code}: {suspects.join(', ')}. Nothing in the records rules them out, so the store pulls the product.</p>
          </div>;
        })}
      </>}

      {(store.status === 'safe' || clean.length > 0) && <>
        <h3>{store.status === 'safe' ? 'Lots it received, traced back' : 'Also received, cleared'}</h3>
        <ul className="proof">
          {clean.map((s) => (
            <li key={s.lot}>
              <b>{s.lot}</b>, {s.units} units of {s.product}, {shortDate(s.shipped_at)}
              <span>Made from {s.origins.join(', ')}. No {r.lot.code}.</span>
            </li>
          ))}
        </ul>
      </>}

      {notice && <>
        <h3>Store notice</h3>
        <pre className="notice-text">{notice.text}</pre>
        {notice.status === 'approved'
          ? <p className="ok">Approved. Nothing has been sent.</p>
          : <button className="primary" disabled={!canApprove} title={canApprove ? '' : 'Confirm the class and depth first'} onClick={() => onApprove(store.id)}>Approve this notice</button>}
      </>}
    </aside>
  );
}

// --- Notices ----------------------------------------------------------------

export function Notices({ lot, notices, canApprove, onApprove, onPick }: { lot: string; notices: Notice[]; canApprove: boolean; onApprove: (ids: string[]) => void; onPick: (id: string) => void }) {
  const pending = notices.filter((n) => n.status === 'pending_approval');
  const approved = notices.length - pending.length;
  const byState = useMemo(() => {
    const m = new Map<string, Notice[]>();
    notices.forEach((n) => { const st = n.city.split(', ')[1] ?? ''; m.set(st, [...(m.get(st) ?? []), n]); });
    return [...m].sort((a, b) => b[1].length - a[1].length);
  }, [notices]);
  if (!notices.length) return null;
  return (
    <section className="panel notices">
      <header className="panel-head"><h2>Store notices</h2><span className="count">{approved} of {notices.length} approved</span></header>
      <div className="progress" role="progressbar" aria-valuenow={approved} aria-valuemax={notices.length}><i style={{ width: `${(100 * approved) / notices.length}%` }} /></div>
      <ul className="by-state">
        {byState.map(([st, list]) => (
          <li key={st}>
            <span className="st">{st}</span>
            <span className="pips">{list.map((n) => <i key={n.store} title={`${n.name}: ${n.status === 'approved' ? 'approved' : 'awaiting approval'}`} className={n.status === 'approved' ? 'done' : ''} onClick={() => onPick(n.store)} />)}</span>
            {list.some((n) => n.status !== 'approved') && <button className="link-btn" disabled={!canApprove} onClick={() => onApprove(list.filter((n) => n.status !== 'approved').map((n) => n.store))}>Approve {st}</button>}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="primary" disabled={!pending.length || !canApprove} onClick={() => onApprove(pending.map((n) => n.store))}>{pending.length ? `Approve all ${pending.length}` : 'All approved'}</button>
        <a className="secondary" href={`/export/${lot}.csv`} download>FDA shipping CSV</a>
      </div>
      <p className="muted small">{canApprove ? 'Approving marks a notice ready for the distribution team. Nothing is sent from here.' : 'Confirm the class and depth in the assessment card before approving notices.'}</p>
    </section>
  );
}
