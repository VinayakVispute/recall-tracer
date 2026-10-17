import { useMemo, useState } from 'react';
import type { IncidentReport } from '../../src/tools/incident';
import type { ToolCall } from '../../src/agent/run';
import type { Notice } from '../../src/tools/index';

type Report = IncidentReport;
type Store = Report['stores'][number];
const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
export const STATUS_LABEL = { recall: 'Recall', gap: 'Gap', safe: 'Safe' } as const;

export function StatusBadge({ s }: { s: Store['status'] }) {
  return <span className={`badge ${s}`}>{STATUS_LABEL[s]}</span>;
}

// --- Agent trace ------------------------------------------------------------

export type Step =
  | { kind: 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; running: boolean; call?: ToolCall };

/** Big inputs (33 notices, 60 product lots) are condensed so the trace stays readable. */
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
      <header className="panel-head"><h2>Agent trace</h2>{running && <span className="live">Running</span>}</header>
      {!steps.length && !running && <p className="muted">Press Trace to run the agent. Each tool call it makes through MCP appears here as it happens.</p>}
      <ol className="steps">
        {steps.map((s, i) => s.kind === 'note' ? (
          <li key={i} className="note">{s.text}</li>
        ) : (
          <li key={s.id ?? i} className={`step ${s.running ? 'running' : ''} ${s.call?.error ? 'failed' : ''}`}>
            <span className="step-n">{++n}</span>
            <div className="step-body">
              <div className="step-top"><code>{s.name}</code><span className="ms">{s.call ? `${s.call.ms} ms` : '…'}</span></div>
              <p className="step-sum">{s.running ? 'Querying the graph' : s.call?.summary}</p>
              {s.name === 'minimal_recall' && s.call && (
                <p className="decision">Decision: gap stores {(s.input as any)?.add_gap_stores === false ? 'flagged for a human' : 'added to the recall'}, because they can't be proven safe.</p>
              )}
              {s.call && (
                <button className="link-btn" aria-expanded={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
                  {open === i ? 'Hide query' : 'Show input and Cypher'}
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
      {summary && <div className="agent-summary"><h3>Agent's conclusion</h3><p>{summary.replace(/\*\*|__|^#+\s*/gm, '')}</p></div>}
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
        <h2>Stores <span className="count">{rows.length}</span></h2>
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
          <thead><tr><th>Status</th><th>Store</th><th>Location</th><th>Lots received</th><th className="num">Units at risk</th><th>Last shipped</th><th>Notice</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={selected === s.id ? 'selected' : ''} onClick={() => onPick(s.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(s.id)}>
                <td><StatusBadge s={s.status} /></td>
                <td><b>{s.name}</b><span className="sub">{s.id}</span></td>
                <td>{s.city}, {s.region}</td>
                <td><div className="lots">
                  {s.shipments.map((x) => <span key={x.lot} className={`lot-chip ${x.affected ? 'bad' : ''}`}>{x.lot}</span>)}
                  {s.untracked.map((u, i) => <span key={i} className="lot-chip unknown">{u.sku}, no lot code</span>)}
                </div></td>
                <td className="num">{s.units_at_risk ? fmt(s.units_at_risk) : '0'}</td>
                <td>{shortDate(s.last_shipped)}</td>
                <td>{noticeOf.get(s.id) === 'approved' ? <span className="ok">Approved</span> : noticeOf.get(s.id) ? 'Draft' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Evidence drawer --------------------------------------------------------

export function Evidence({ r, store, notice, onClose, onApprove }: {
  r: Report; store: Store; notice?: Notice; onClose: () => void; onApprove: (id: string) => void;
}) {
  const edge = (s: string, t: string) => r.lineage.find((e) => e.source === s && e.target === t);
  const batch = (id: string) => r.batches.find((b) => b.id === id);
  const pl = (id: string) => r.product_lots.find((p) => p.id === id);
  const bad = store.shipments.filter((s) => s.affected), clean = store.shipments.filter((s) => !s.affected);
  return (
    <aside className="drawer" aria-label={`Evidence for ${store.name}`}>
      <header className="drawer-head">
        <div><StatusBadge s={store.status} /><h2>{store.name}</h2><p className="muted">{store.id}, {store.city}, {store.region}</p></div>
        <button className="close" onClick={onClose} aria-label="Close evidence">✕</button>
      </header>

      {store.status === 'recall' && <>
        <h3>Why it is on the recall</h3>
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
                    <b>{id}</b>{e?.type === 'REWORKED_INTO' ? `, reused ${e.qty_kg} kg of ${p[i]} leftovers` : `, used ${e?.qty_kg} kg`}
                    <span>{b?.site}, produced {shortDate(b?.produced_at ?? '')}</span>
                  </li>;
                }
                const x = pl(id);
                return <li key={id}><b>{id}</b>, {x?.product}<span>{fmt(e?.units ?? 0)} units produced from {p[i]}</span></li>;
              })}
              <li className="end"><b>Shipped {ship?.units} units</b> to this store<span>{shortDate(ship?.shipped_at ?? '')}</span></li>
            </ol>
          );
        })}
      </>}

      {store.status === 'gap' && <>
        <h3>Why it can't be cleared</h3>
        {store.untracked.map((u, i) => {
          const suspects = r.product_lots.filter((p) => p.sku === u.sku && p.affected).map((p) => p.id);
          return <div key={i} className="gap-card">
            <p><b>{u.units} units of {u.product}</b> arrived {shortDate(u.shipped_at)} with no lot code recorded.</p>
            <p>{u.sku} lots that contain {r.lot.code}: {suspects.join(', ')}. The records can't rule them out, so the agent added this store.</p>
          </div>;
        })}
      </>}

      {(store.status === 'safe' || clean.length > 0) && <>
        <h3>{store.status === 'safe' ? 'Why it is safe' : 'Also received (clean)'}</h3>
        <ul className="proof">
          {clean.map((s) => (
            <li key={s.lot}>
              <b>{s.lot}</b>, {s.units} units of {s.product}, {shortDate(s.shipped_at)}
              <span>Traced back to {s.origins.join(', ')}. No {r.lot.code}.</span>
            </li>
          ))}
        </ul>
      </>}

      {notice && <>
        <h3>Recall notice</h3>
        <pre className="notice-text">{notice.text}</pre>
        {notice.status === 'approved'
          ? <p className="ok">Approved. Nothing has been sent.</p>
          : <button className="primary" onClick={() => onApprove(store.id)}>Approve this notice</button>}
      </>}
    </aside>
  );
}

// --- Notices ----------------------------------------------------------------

export function Notices({ lot, notices, onApprove, onPick }: { lot: string; notices: Notice[]; onApprove: (ids: string[]) => void; onPick: (id: string) => void }) {
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
      <header className="panel-head"><h2>Notices</h2><span className="count">{approved} of {notices.length} approved</span></header>
      <div className="progress" role="progressbar" aria-valuenow={approved} aria-valuemax={notices.length}><i style={{ width: `${(100 * approved) / notices.length}%` }} /></div>
      <ul className="by-state">
        {byState.map(([st, list]) => (
          <li key={st}>
            <span className="st">{st}</span>
            <span className="pips">{list.map((n) => <i key={n.store} title={`${n.name}: ${n.status === 'approved' ? 'approved' : 'awaiting approval'}`} className={n.status === 'approved' ? 'done' : ''} onClick={() => onPick(n.store)} />)}</span>
            {list.some((n) => n.status !== 'approved') && <button className="link-btn" onClick={() => onApprove(list.filter((n) => n.status !== 'approved').map((n) => n.store))}>Approve {st}</button>}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="primary" disabled={!pending.length} onClick={() => onApprove(pending.map((n) => n.store))}>{pending.length ? `Approve all ${pending.length}` : 'All approved'}</button>
        <a className="secondary" href={`/export/${lot}.csv`} download>FDA shipping CSV</a>
      </div>
      <p className="muted small">Approving marks a notice ready. Nothing is sent from here.</p>
    </section>
  );
}
