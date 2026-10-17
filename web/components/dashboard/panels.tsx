"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { Incident, IncidentReport } from "@server/tools/incident"
import { JUDGEMENT, toolTotals, type Step } from "@/lib/trace"
import type { Notice } from "@server/tools/index"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Report = IncidentReport
type Store = Report["stores"][number]
export const fmt = (n: number) => n.toLocaleString()
export const shortDate = (iso: string) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "")
export const shortTime = (iso: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "")
export const STATUS_LABEL = { recall: "Pull product", gap: "Pull, no record", safe: "Cleared" } as const
export const chainOf = (name: string) => name.split(" #")[0]

const STATUS_VARIANT = { recall: "destructive", gap: "default", safe: "secondary" } as const

export function StatusBadge({ s }: { s: Store["status"] }) {
  return <Badge variant={STATUS_VARIANT[s]}>{STATUS_LABEL[s]}</Badge>
}

/** How a product lot came to contain the bad lot, in words, from the lineage edges. */
export function via(r: Report, batch: string) {
  const used = r.lineage.find((e) => e.type === "USED_IN" && e.target === batch)
  if (used) return `${used.qty_kg} kg of ${r.lot.code} used in ${batch}`
  const rw = r.lineage.find((e) => e.type === "REWORKED_INTO" && e.target === batch)
  return rw ? `${rw.qty_kg} kg of leftovers from ${rw.source} reworked into ${batch}` : `made in ${batch}`
}

const Sub = ({ children }: { children: React.ReactNode }) => <span className="block text-xs text-muted-foreground">{children}</span>
const Muted = ({ children, className }: { children: React.ReactNode; className?: string }) => <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>

// --- Hazard assessment (agent proposes, coordinator confirms) ---------------

const CLASS_TEXT: Record<string, string> = {
  I: "reasonable probability of serious health consequences or death",
  II: "temporary or medically reversible health effects",
  III: "not likely to cause adverse health consequences",
}
const DEPTH_TEXT: Record<string, string> = {
  consumer: "product is on shelves, the public must be told",
  retail: "stores pull it, no public notice",
  wholesale: "still in distribution, pull from DCs",
}
const CLASS_ITEMS = ["I", "II", "III"].map((k) => ({ value: k, label: `Class ${k}: ${CLASS_TEXT[k]}` }))
const DEPTH_ITEMS = ["consumer", "retail", "wholesale"].map((k) => ({ value: k, label: `${k[0].toUpperCase() + k.slice(1)}: ${DEPTH_TEXT[k]}` }))

export function Assessment({ incident, running, onConfirm }: { incident: Incident; running: boolean; onConfirm: (cls: string, depth: string) => void }) {
  const [cls, setCls] = useState<string>()
  const [depth, setDepth] = useState<string>()
  if (!incident.class) return (
    <Card>
      <CardHeader>
        <CardTitle>Hazard assessment</CardTitle>
        <CardDescription>{running ? "The agent is assessing the hazard and will propose a recall class and depth." : "Not assessed yet."}</CardDescription>
      </CardHeader>
    </Card>
  )
  const c = cls ?? incident.class, d = depth ?? incident.depth!
  if (incident.confirmed_at) return (
    <Card>
      <CardHeader>
        <CardTitle>Class {incident.confirmed_class}, {incident.confirmed_depth}-level recall</CardTitle>
        <CardDescription>Confirmed by the coordinator at {shortTime(incident.confirmed_at)}{incident.confirmed_class !== incident.class || incident.confirmed_depth !== incident.depth ? `, changed from the agent's proposal of Class ${incident.class}, ${incident.depth}` : ", as the agent proposed"}. {CLASS_TEXT[incident.confirmed_class!]}; {DEPTH_TEXT[incident.confirmed_depth!]}.</CardDescription>
      </CardHeader>
    </Card>
  )
  return (
    <Card>
      <CardHeader>
        <CardDescription>Hazard assessment, proposed by the agent</CardDescription>
        <CardTitle>Class {incident.class}, {incident.depth}-level recall</CardTitle>
        <p className="text-sm">{incident.rationale}</p>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onConfirm(c, d) }}>
          <div className="flex flex-col gap-1.5">
            <Label>Class</Label>
            <Select items={CLASS_ITEMS} value={c} onValueChange={(v) => v && setCls(v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CLASS_ITEMS.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Depth</Label>
            <Select items={DEPTH_ITEMS} value={d} onValueChange={(v) => v && setDepth(v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{DEPTH_ITEMS.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button type="submit" className="self-start">{c === incident.class && d === incident.depth ? "Confirm" : "Confirm with changes"}</Button>
          <Muted className="text-xs">Notices can be approved only after this. FDA assigns the final class; this is the firm&apos;s assessment.</Muted>
        </form>
      </CardContent>
    </Card>
  )
}

// --- Scope table: one row per affected product lot --------------------------

export function ScopeTable({ r }: { r: Report }) {
  const lots = r.product_lots.filter((p) => p.affected).sort((a, b) => a.id.localeCompare(b.id))
  const batch = (id: string) => r.batches.find((b) => b.id === id)
  const sum = (k: "units" | "shipped" | "held") => lots.reduce((n, p) => n + p[k], 0)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product lot</TableHead><TableHead>Product</TableHead><TableHead>Made</TableHead><TableHead>Contains {r.lot.code} via</TableHead><TableHead>Best by</TableHead>
          <TableHead className="text-right">Made</TableHead><TableHead className="text-right">Shipped to stores</TableHead><TableHead className="text-right">On hold</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lots.map((p) => {
          const b = batch(p.batch)
          const how = via(r, p.batch)
          return (
            <TableRow key={p.id}>
              <TableCell className="font-mono font-medium">{p.id}</TableCell>
              <TableCell>{p.product}<Sub>UPC {p.upc}</Sub></TableCell>
              <TableCell>{shortDate(p.produced_at)}<Sub>{b?.site.split(",")[0]}</Sub></TableCell>
              <TableCell className="whitespace-normal">{how.includes("rework") ? <Badge variant="outline" className="h-auto whitespace-normal">{how}</Badge> : how}</TableCell>
              <TableCell>{shortDate(p.best_by)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(p.units)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(p.shipped)}<Sub>{p.stores} stores</Sub></TableCell>
              <TableCell className="text-right tabular-nums">{fmt(p.held)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={5}>{lots.length} product lots</TableCell>
          <TableCell className="text-right tabular-nums">{fmt(sum("units"))}</TableCell>
          <TableCell className="text-right tabular-nums">{fmt(sum("shipped"))}</TableCell>
          <TableCell className="text-right tabular-nums">{fmt(sum("held"))}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

/** One paragraph that reads the lineage out loud. */
export function ScopeStory({ r }: { r: Report }) {
  const used = r.lineage.filter((e) => e.type === "USED_IN")
  const rework = r.lineage.filter((e) => e.type === "REWORKED_INTO")
  const lots = r.product_lots.filter((p) => p.affected)
  const hit = r.stores.filter((s) => s.status !== "safe")
  const states = new Set(hit.map((s) => s.region))
  const sites = [...new Set(r.batches.map((b) => b.site.split(",")[0]))]
  const kg = used.reduce((n, e) => n + (e.qty_kg ?? 0), 0)
  return (
    <p className="text-sm/relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
      <b>{kg} kg of {r.lot.code}</b> went into {used.length} batches ({used.map((e) => e.target).join(", ")}) at {sites.join(" and ")}.
      {rework.map((e) => <span key={e.target}> Then <b>{e.qty_kg} kg of leftovers from {e.source} were reworked into {e.target}</b>, which carried it into one more lot.</span>)}
      {" "}Those batches made {lots.length} product lots of {r.skus.map((s) => s.product).join(", ")}.
      {" "}<b>{fmt(lots.reduce((n, p) => n + p.shipped, 0))} units reached {hit.filter((s) => s.status === "recall").length} stores</b> in {states.size} states{hit.some((s) => s.status === "gap") ? <>, plus {fmt(hit.flatMap((s) => s.untracked).reduce((n, u) => n + u.units, 0))} units delivered to {hit.filter((s) => s.status === "gap").length} stores with no lot code</> : null}; {fmt(lots.reduce((n, p) => n + p.held, 0))} units never left and are on hold.
    </p>
  )
}

// --- Public notice facts ------------------------------------------------------

export function PublicNotice({ r }: { r: Report }) {
  const hit = r.stores.filter((s) => s.status !== "safe")
  const chains = [...new Set(hit.map((s) => chainOf(s.name)))].sort()
  const states = [...new Set(hit.map((s) => s.region))].sort()
  const lots = r.product_lots.filter((p) => p.affected)
  const [copied, setCopied] = useState<"" | "ok" | "fail">("")
  const text = [
    `Recall: ${r.skus.map((s) => s.product).join(", ")}`,
    `Reason: ${r.incident?.hazard ?? "contamination"}`,
    ...r.skus.map((s) => {
      const ls = lots.filter((p) => p.sku === s.sku)
      const bb = ls.map((p) => p.best_by).sort()
      return `${s.product}, UPC ${s.upc}, lot codes ${ls.map((p) => p.id).join(", ")}, best by ${bb.length ? `${shortDate(bb[0])}${bb.length > 1 && bb.at(-1) !== bb[0] ? ` to ${shortDate(bb.at(-1)!)}` : ""}` : "n/a"}`
    }),
    `Sold at ${chains.join(", ")} stores in ${states.join(", ")}.`,
    "Consumers should not eat the product and may return it for a refund.",
  ].join("\n")
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied("ok") } catch { setCopied("fail") }
    setTimeout(() => setCopied(""), 2500)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Public notice facts</CardTitle>
        <CardAction className="flex items-center gap-2">
          <Badge variant="outline">Consumer-level recall</Badge>
          <Button size="sm" variant="outline" onClick={copy}>{copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed, select the text" : "Copy notice text"}</Button>
        </CardAction>
        <CardDescription>What the press release must list so shoppers can check their fridge. Read from the graph; nothing is published from here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Table>
          <TableHeader><TableRow><TableHead>Product</TableHead><TableHead>UPC</TableHead><TableHead>Lot codes on pack</TableHead><TableHead>Best by</TableHead></TableRow></TableHeader>
          <TableBody>
            {r.skus.map((s) => {
              const ls = lots.filter((p) => p.sku === s.sku)
              const bb = ls.map((p) => p.best_by).sort()
              return (
                <TableRow key={s.sku}>
                  <TableCell>{s.product}</TableCell>
                  <TableCell className="font-mono">{s.upc}</TableCell>
                  <TableCell className="font-mono whitespace-normal">{ls.map((p) => p.id).join(", ")}</TableCell>
                  <TableCell>{bb.length ? `${shortDate(bb[0])}${bb.length > 1 && bb.at(-1) !== bb[0] ? ` to ${shortDate(bb.at(-1)!)}` : ""}` : ""}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="text-sm">Sold at {chains.join(", ")} stores in {states.join(", ")}. Reason: {r.incident?.hazard ?? "contamination"}. Consumers should not eat the product and may return it for a refund.</p>
      </CardContent>
    </Card>
  )
}

// --- Investigation log ------------------------------------------------------

export type { Step }

export const TITLE: Record<string, string> = {
  propose_classification: "Hazard assessment",
  place_hold: "Hold at plants and DCs",
  trace_forward: "Forward trace",
  coverage_gaps: "Delivery record check",
  unaffected_stores: "Clearance check",
  minimal_recall: "Scope decision",
  trace_backward: "Backward check on cleared stores",
  draft_recall_notice: "Store notices drafted",
}
const DOING: Record<string, string> = {
  propose_classification: "Recording the proposed class and depth",
  place_hold: "Finding unshipped inventory and marking it held",
  trace_forward: "Following the lot through batches, rework and deliveries",
  coverage_gaps: "Looking for deliveries with no lot code",
  minimal_recall: "Combining the traces into a decision",
  trace_backward: "Walking every cleared lot back to its ingredients",
  draft_recall_notice: "Writing one draft per store",
}

/** Big inputs (33 notices, 60 product lots) are condensed so the log stays readable. */
function brief(input: unknown) {
  if (!input || typeof input !== "object") return JSON.stringify(input)
  return Object.entries(input).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} items` : JSON.stringify(v)}`).join(", ")
}

export function AgentTrace({ steps, running, meta, summary, error, current, replaying, onRetry }: {
  steps: Step[]; running: boolean; error?: string; summary?: string;
  meta?: { model: string; ms: number; turns: number; input_tokens: number; output_tokens: number };
  /** Id of the tool call at the replay playhead; highlighted and scrolled into view. */
  current?: string; replaying?: boolean; onRetry?: () => void;
}) {
  const [open, setOpen] = useState<number>()
  const box = useRef<HTMLDivElement>(null)
  const totals = toolTotals(steps)
  // Keep the current step in view inside the log, without scrolling the page.
  useEffect(() => {
    const el = current && box.current?.querySelector<HTMLElement>(`[data-step="${CSS.escape(current)}"]`)
    if (!el || !box.current) return
    const b = box.current, top = el.offsetTop - b.offsetTop
    if (top < b.scrollTop || top + el.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" })
  }, [current])
  let n = 0
  return (
    <Card aria-live={replaying ? "off" : "polite"}>
      <CardHeader>
        <CardTitle>Investigation log</CardTitle>
        <CardAction className="flex flex-col items-end gap-1">
          {running ? <Badge>Running</Badge> : replaying ? <Badge variant="outline">Replay</Badge> : null}
          {totals.calls > 0 && <span className="text-xs text-muted-foreground tabular-nums" title="Each tool is an MCP call that runs its Cypher on FalkorDB">{totals.calls} graph tools, {fmt(totals.ms)} ms</span>}
        </CardAction>
        <CardDescription>Every step the agent took, in order, with the graph query behind it. This is the audit trail.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!steps.length && !running && !replaying && (
          <Empty><EmptyDescription>Open an incident to start. Each step appears here as it happens.</EmptyDescription></Empty>
        )}
        <div ref={box} className="max-h-[32rem] overflow-y-auto pr-1">
          <ol className="flex flex-col gap-3">
            {steps.map((s, i) => s.kind === "note" ? (
              <li key={i} className="text-sm text-muted-foreground italic">{s.text}</li>
            ) : (
              <li key={s.id ?? i} data-step={s.id} className={cn(
                "flex gap-3 rounded-lg p-2 -mx-2 transition-colors",
                JUDGEMENT.has(s.name) && s.call && "border border-chart-4/50 bg-chart-4/5",
                current === s.id && "ring-2 ring-ring",
              )}>
                <Badge variant={s.call?.error ? "destructive" : s.running ? "default" : "secondary"} className="tabular-nums">{++n}</Badge>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="text-sm">{TITLE[s.name] ?? s.name}</b>
                    {JUDGEMENT.has(s.name) && s.call
                      ? <Badge variant="outline" className="border-chart-4 text-chart-4">Agent judgement</Badge>
                      : <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums" title="MCP tool call, including its FalkorDB queries">{s.call ? `graph ${s.call.ms} ms` : "…"}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground">{s.running ? DOING[s.name] ?? "Querying the graph" : s.call?.summary}</p>
                  {s.call?.error && <Badge variant="destructive">Failed</Badge>}
                  {s.name === "minimal_recall" && s.call && (
                    <p className="text-sm"><b>Policy applied:</b> stores with no delivery record are {(s.input as { add_gap_stores?: boolean } | undefined)?.add_gap_stores === false ? "flagged for the coordinator" : "pulled too"}, because the records can&apos;t clear them. A recall that misses contaminated product is worse than one that pulls a few extra units.</p>
                  )}
                  {s.name === "propose_classification" && s.call && (
                    <p className="text-sm"><b>A proposal.</b> The coordinator confirms or changes it in the assessment card above. Notices can&apos;t be approved before that.</p>
                  )}
                  {s.call && (
                    <Collapsible open={open === i} onOpenChange={(o) => setOpen(o ? i : undefined)}>
                      <CollapsibleTrigger render={<Button variant="link" size="xs" className="px-0" />}>
                        {open === i ? "Hide" : `Tool ${s.name}, show input and Cypher`}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="flex flex-col gap-2 pt-1">
                        <p className="font-mono text-xs break-words"><b>Input</b> {brief(s.input)}</p>
                        <p className="text-xs text-muted-foreground">{s.call.ms} ms for the MCP call{s.call.cypher.length > 1 ? `, ${s.call.cypher.length} queries` : ""}.</p>
                        {(s.call.cypher ?? []).map((q, j) => <pre key={j} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{q.trim()}</pre>)}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-col gap-2">
              <span>{error}</span>
              {onRetry && !running && <Button size="sm" variant="outline" className="self-start" onClick={onRetry}>Retry the run</Button>}
            </AlertDescription>
          </Alert>
        )}
        {summary && (
          <>
            <Separator />
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Agent&apos;s summary</h3>
              <p className="text-sm text-muted-foreground">{summary.replace(/\*\*|__|^#+\s*/gm, "")}</p>
            </div>
          </>
        )}
        {meta && <p className="text-xs text-muted-foreground tabular-nums">{meta.model}, {meta.turns} turns, {(meta.ms / 1000).toFixed(1)} s, {fmt(meta.input_tokens + meta.output_tokens)} tokens</p>}
      </CardContent>
    </Card>
  )
}

// --- Store register ---------------------------------------------------------

export type Filter = "all" | Store["status"]

/** The filter can be driven from outside (the headline tiles), or left to the table's own buttons. */
export function StoreRegister({ r, notices, onPick, selected, stateFilter, clearState, filter: outer, onFilter }: {
  r: Report; notices: Notice[]; onPick: (id: string) => void; selected?: string; stateFilter?: string; clearState: () => void;
  filter?: Filter; onFilter?: (f: Filter) => void;
}) {
  const [own, setOwn] = useState<Filter>("all")
  const filter = outer ?? own
  const setFilter = onFilter ?? setOwn
  const [q, setQ] = useState("")
  const noticeOf = useMemo(() => new Map(notices.map((n) => [n.store, n.status])), [notices])
  const count = (f: Filter) => r.stores.filter((s) => f === "all" || s.status === f).length
  const rows = r.stores.filter((s) =>
    (filter === "all" || s.status === filter) && (!stateFilter || s.region === stateFilter) &&
    (!q || `${s.id} ${s.name} ${s.city} ${s.shipments.map((x) => x.lot).join(" ")}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <Card id="store-decisions" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Store decisions <Badge variant="secondary" className="tabular-nums">{rows.length}</Badge></CardTitle>
        <CardDescription>Every store that stocked the affected products, and what the records say. Click a row for the evidence.</CardDescription>
        <CardAction className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Filter stores">
          {(["all", "recall", "gap", "safe"] as Filter[]).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : STATUS_LABEL[f]} <span className="tabular-nums">{count(f)}</span>
            </Button>
          ))}
          {stateFilter && <Button size="sm" variant="secondary" aria-pressed onClick={clearState}>{stateFilter} ✕</Button>}
          <Input className="w-56" type="search" placeholder="Search store, city or lot" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stores" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Decision</TableHead><TableHead>Store</TableHead><TableHead>Location</TableHead><TableHead>Received</TableHead>
              <TableHead className="text-right">Units to pull</TableHead><TableHead>Last delivery</TableHead><TableHead>Notice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id} className={cn("cursor-pointer", selected === s.id && "bg-muted")} aria-selected={selected === s.id} onClick={() => onPick(s.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick(s.id)}>
                <TableCell><StatusBadge s={s.status} /></TableCell>
                <TableCell className="font-medium">{s.name}<Sub><span className="font-mono">{s.id}</span></Sub></TableCell>
                <TableCell>{s.city}, {s.region}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.shipments.map((x) => <Badge key={x.lot} variant={x.affected ? "destructive" : "outline"} className="font-mono" title={`${x.units} units of ${x.product}, ${shortDate(x.shipped_at)}`}>{x.lot}</Badge>)}
                    {s.untracked.map((u, i) => <Badge key={i} variant="outline" className="border-dashed" title={`${u.units} units of ${u.product}, ${shortDate(u.shipped_at)}`}>{u.product}, no lot code</Badge>)}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{s.units_at_risk ? fmt(s.units_at_risk) : "0"}</TableCell>
                <TableCell>{shortDate(s.last_shipped)}</TableCell>
                <TableCell>{noticeOf.get(s.id) === "approved" ? <Badge>Approved</Badge> : noticeOf.get(s.id) ? <Badge variant="outline">Draft</Badge> : <span className="text-muted-foreground">None needed</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// --- Evidence drawer --------------------------------------------------------

export function Evidence({ r, store, notice, canApprove, onClose, onApprove }: {
  r: Report; store: Store; notice?: Notice; canApprove: boolean; onClose: () => void; onApprove: (id: string) => void;
}) {
  const edge = (s: string, t: string) => r.lineage.find((e) => e.source === s && e.target === t)
  const batch = (id: string) => r.batches.find((b) => b.id === id)
  const pl = (id: string) => r.product_lots.find((p) => p.id === id)
  const bad = store.shipments.filter((s) => s.affected), clean = store.shipments.filter((s) => !s.affected)
  const lead = store.status === "recall"
    ? <>Pull product. {store.name} received {bad.map((s) => `${s.units} units of ${s.product} (${s.lot}) on ${shortDate(s.shipped_at)}`).join(" and ")}. {bad.length > 1 ? "Both lots contain" : `${bad[0]?.lot} contains`} {r.lot.code}{bad.some((s) => via(r, pl(s.lot)?.batch ?? "").includes("rework")) ? ", through rework" : ""}.</>
    : store.status === "gap"
      ? <>Pull to be safe. {store.name} received {store.untracked.map((u) => `${u.units} units of ${u.product} on ${shortDate(u.shipped_at)}`).join(" and ")} with no lot code on the delivery record, so the records can&apos;t show whether it came from a contaminated lot.</>
      : <>Cleared. Every lot {store.name} received was traced back to its ingredients: {clean.map((s) => s.lot).join(", ")}. None contains {r.lot.code}.</>
  const h3 = "text-sm font-medium"
  const step = "flex flex-col text-sm [&_span]:text-xs [&_span]:text-muted-foreground"
  return (
    <Card aria-label={`Evidence for ${store.name}`}>
      <CardHeader>
        <StatusBadge s={store.status} />
        <CardTitle>{store.name}</CardTitle>
        <CardDescription><span className="font-mono">{store.id}</span>, {store.city}, {store.region}</CardDescription>
        <CardAction><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close evidence">✕</Button></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert variant={store.status === "recall" ? "destructive" : "default"}><AlertDescription className={store.status === "recall" ? "text-destructive" : undefined}>{lead}</AlertDescription></Alert>

        {store.status === "recall" && <>
          <h3 className={h3}>The records behind it</h3>
          {store.paths.map((p) => {
            const ship = bad.find((s) => s.lot === p.at(-2))
            return (
              <ol key={p.join()} className="flex flex-col gap-2 border-l pl-3">
                <li className={step}><b>{r.lot.code}</b>, {r.lot.ingredient}<span>Supplied by {r.lot.supplier}, received {shortDate(r.lot.received_at)}</span></li>
                {p.slice(1, -1).map((id, i) => {
                  const e = edge(p[i], id)
                  if (id.startsWith("B-")) {
                    const b = batch(id)
                    return <li key={id} className={step}>
                      <span className="text-foreground!"><b>Batch {id}</b>{e?.type === "REWORKED_INTO" ? `, reused ${e.qty_kg} kg of ${p[i]} leftovers` : `, used ${e?.qty_kg} kg`}</span>
                      {e?.type === "REWORKED_INTO" && <Badge variant="outline" className="my-0.5">Rework</Badge>}
                      <span>{b?.site}, produced {shortDate(b?.produced_at ?? "")}</span>
                    </li>
                  }
                  const x = pl(id)
                  return <li key={id} className={step}><span className="text-foreground!"><b>Lot {id}</b>, {x?.product}</span><span>{fmt(e?.units ?? 0)} units made from {p[i]}, best by {shortDate(x?.best_by ?? "")}</span></li>
                })}
                <li className={step}><span className="text-foreground!"><b>Delivered {ship?.units} units</b> to this store</span><span>{shortDate(ship?.shipped_at ?? "")}</span></li>
              </ol>
            )
          })}
        </>}

        {store.status === "gap" && <>
          <h3 className={h3}>The missing record</h3>
          {store.untracked.map((u, i) => {
            const suspects = r.product_lots.filter((p) => p.sku === u.sku && p.affected).map((p) => p.id)
            return <div key={i} className="flex flex-col gap-1 rounded-lg border border-dashed p-3 text-sm">
              <p><b>{u.units} units of {u.product}</b> arrived {shortDate(u.shipped_at)}. The delivery record has no lot code.</p>
              <p>Lots of {u.product} that contain {r.lot.code}: <span className="font-mono">{suspects.join(", ")}</span>. Nothing in the records rules them out, so the store pulls the product.</p>
            </div>
          })}
        </>}

        {(store.status === "safe" || clean.length > 0) && <>
          <h3 className={h3}>{store.status === "safe" ? "Lots it received, traced back" : "Also received, cleared"}</h3>
          <ul className="flex flex-col gap-2">
            {clean.map((s) => (
              <li key={s.lot} className={step}>
                <span className="text-foreground!"><b className="font-mono">{s.lot}</b>, {s.units} units of {s.product}, {shortDate(s.shipped_at)}</span>
                <span>Made from {s.origins.join(", ")}. No {r.lot.code}.</span>
              </li>
            ))}
          </ul>
        </>}

        {notice && <>
          <Separator />
          <h3 className={h3}>Store notice</h3>
          <pre className="font-mono text-xs break-words whitespace-pre-wrap rounded-md bg-muted p-3">{notice.text}</pre>
          {notice.status === "approved"
            ? <Badge className="self-start">Approved. Nothing has been sent.</Badge>
            : <Button className="self-start" disabled={!canApprove} title={canApprove ? "" : "Confirm the class and depth first"} onClick={() => onApprove(store.id)}>Approve this notice</Button>}
        </>}
      </CardContent>
    </Card>
  )
}

// --- Notices ----------------------------------------------------------------

export function Notices({ lot, notices, canApprove, onApprove, onPick }: { lot: string; notices: Notice[]; canApprove: boolean; onApprove: (ids: string[]) => void; onPick: (id: string) => void }) {
  const pending = notices.filter((n) => n.status === "pending_approval")
  const approved = notices.length - pending.length
  const byState = useMemo(() => {
    const m = new Map<string, Notice[]>()
    notices.forEach((n) => { const st = n.city.split(", ")[1] ?? ""; m.set(st, [...(m.get(st) ?? []), n]) })
    return [...m].sort((a, b) => b[1].length - a[1].length)
  }, [notices])
  if (!notices.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Store notices</CardTitle>
        <CardAction><Badge variant="secondary" className="tabular-nums">{approved} of {notices.length} approved</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={approved} aria-valuemin={0} aria-valuemax={notices.length}>
          <div className="h-full bg-primary" style={{ width: `${(100 * approved) / notices.length}%` }} />
        </div>
        <ul className="flex flex-col gap-2">
          {byState.map(([st, list]) => (
            <li key={st} className="flex items-center gap-3">
              <span className="w-8 text-sm font-medium">{st}</span>
              <span className="flex flex-1 flex-wrap gap-1">
                {list.map((n) => (
                  <button
                    key={n.store}
                    type="button"
                    title={`${n.name}: ${n.status === "approved" ? "approved" : "awaiting approval"}`}
                    aria-label={`${n.name}: ${n.status === "approved" ? "approved" : "awaiting approval"}`}
                    className={cn("size-3 rounded-full border border-primary", n.status === "approved" && "bg-primary")}
                    onClick={() => onPick(n.store)}
                  />
                ))}
              </span>
              {list.some((n) => n.status !== "approved") && (
                <Button variant="link" size="xs" disabled={!canApprove} onClick={() => onApprove(list.filter((n) => n.status !== "approved").map((n) => n.store))}>Approve {st}</Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!pending.length || !canApprove} onClick={() => onApprove(pending.map((n) => n.store))}>{pending.length ? `Approve all ${pending.length}` : "All approved"}</Button>
          <Button variant="outline" nativeButton={false} render={<a href={`/export/${lot}.csv`} download />}>FDA shipping CSV</Button>
        </div>
        <Muted className="text-xs">{canApprove ? "Approving marks a notice ready for the distribution team. Nothing is sent from here." : "Confirm the class and depth in the assessment card before approving notices."}</Muted>
      </CardContent>
    </Card>
  )
}
