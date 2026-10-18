"use client"

import { useMemo, useState } from "react"
import type { IncidentReport } from "@server/tools/incident"
import { ArrowDown, ArrowUp, ArrowUpDown, CircleCheck, FileQuestion, OctagonAlert, Search, SearchX } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type Store = IncidentReport["stores"][number]
type Status = Store["status"]
type SortKey = "decision" | "store" | "state" | "units"

const ORDER: Status[] = ["recall", "gap", "safe"]
const META = {
  recall: { label: "Pull", Icon: OctagonAlert, text: "text-destructive", badge: "destructive" as const, tone: "" },
  gap: { label: "Pull, no lot code", Icon: FileQuestion, text: "text-chart-1", badge: "outline" as const, tone: "border-chart-1/50 text-chart-1" },
  safe: { label: "Cleared", Icon: CircleCheck, text: "text-muted-foreground", badge: "secondary" as const, tone: "" },
}
const fmt = (n: number) => n.toLocaleString()

/** The reason the decision was made, read from the store's own shipments and trace paths. */
function why(s: Store, code: string) {
  if (s.status === "recall") {
    const bad = s.shipments.filter((x) => x.affected).map((x) => `${x.product} (lot ${x.lot})`)
    const path = s.paths[0]?.join(" → ")
    return { text: `Received ${bad.join(" and ")}, made with ${code}.`, path, extra: Math.max(0, s.paths.length - 1) }
  }
  if (s.status === "gap") return { text: s.untracked[0]?.reason ?? `Delivered product with no lot code; cannot be proven free of ${code}.` }
  const lots = s.shipments.map((x) => x.lot)
  return { text: lots.length ? `Only received ${lots.join(", ")}, none made with ${code}.` : `No shipments of the affected products.` }
}

export type ScopeFilter = "all" | Status
const NOTICE = { approved: "Approved", pending_approval: "Draft" } as const

/**
 * The one store table. The headline tiles can drive `filter`, the state bars `region`; `notices` adds each store's
 * notice status. Left out, the table keeps its own filter and shows no notice column.
 */
export function ScopeTable({ r, focus, onPick, filter: outer, onFilter, region, onClearRegion, notices }: {
  r: IncidentReport; focus?: string; onPick?: (store: string) => void
  filter?: ScopeFilter; onFilter?: (f: ScopeFilter) => void; region?: string; onClearRegion?: () => void
  notices?: Map<string, keyof typeof NOTICE>
}) {
  const [q, setQ] = useState("")
  const [own, setOwn] = useState<ScopeFilter>("all")
  const filter = outer ?? own
  const setFilter = onFilter ?? setOwn
  const cols = notices ? 6 : 5
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "decision", dir: 1 })

  const counts = useMemo(() => {
    const c = { all: r.stores.length, recall: 0, gap: 0, safe: 0 }
    for (const s of r.stores) c[s.status]++
    return c
  }, [r.stores])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hit = r.stores.filter(
      (s) => (filter === "all" || s.status === filter) && (!region || s.region === region) && (!needle || [s.id, s.name, s.city, s.region].some((v) => v.toLowerCase().includes(needle))),
    )
    const cmp: Record<SortKey, (a: Store, b: Store) => number> = {
      decision: (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.units_at_risk - a.units_at_risk,
      store: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      state: (a, b) => a.region.localeCompare(b.region) || a.city.localeCompare(b.city),
      units: (a, b) => a.units_at_risk - b.units_at_risk,
    }
    return hit.sort((a, b) => cmp[sort.key](a, b) * sort.dir || a.id.localeCompare(b.id))
  }, [r.stores, q, filter, region, sort])

  const toggle = (key: SortKey) => setSort((p) => (p.key === key ? { key, dir: (-p.dir) as 1 | -1 } : { key, dir: key === "units" ? -1 : 1 }))
  const Head = ({ k, children, right }: { k: SortKey; children: string; right?: boolean }) => {
    const Icon = sort.key !== k ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown
    return (
      <TableHead className={right ? "text-right" : undefined} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" onClick={() => toggle(k)} className={cn("inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", sort.key === k && "text-foreground")}>
          {children}
          <Icon className="size-3" aria-hidden />
        </button>
      </TableHead>
    )
  }

  const grouped = sort.key === "decision"
  const shownUnits = rows.reduce((n, s) => n + s.units_at_risk, 0)
  let prev: Status | null = null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <InputGroup className="sm:max-w-xs">
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search store, city or state" aria-label="Search stores" />
        </InputGroup>
        <ToggleGroup
          multiple={false}
          value={[filter]}
          onValueChange={(v) => setFilter((v[0] as ScopeFilter) ?? "all")}
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          aria-label="Filter by decision"
        >
          <ToggleGroupItem value="all">All {counts.all}</ToggleGroupItem>
          {ORDER.map((st) => (
            <ToggleGroupItem key={st} value={st}>{META[st].label} {counts[st]}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {region && onClearRegion && <Button size="sm" variant="secondary" onClick={onClearRegion} aria-label={`Show all states, not only ${region}`}>{region} ✕</Button>}
      </div>

      {rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle className="flex items-center gap-2"><SearchX className="size-4" aria-hidden />No stores match</EmptyTitle>
            <EmptyDescription>Try a different search or clear the filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <Head k="store">Store</Head>
              <Head k="state">State</Head>
              <Head k="decision">Decision</Head>
              <Head k="units" right>Units to pull</Head>
              <TableHead>Why</TableHead>
              {notices && <TableHead>Notice</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const m = META[s.status]
              const w = why(s, r.lot.code)
              const header = grouped && prev !== s.status
              prev = s.status
              return (
                <GroupedRow key={s.id} cols={cols} header={header ? { status: s.status, n: rows.filter((x) => x.status === s.status).length } : null}>
                  <TableRow
                    tabIndex={onPick ? 0 : undefined}
                    data-state={focus === s.id ? "selected" : undefined}
                    aria-selected={focus === s.id || undefined}
                    onClick={() => onPick?.(s.id)}
                    onKeyDown={(e) => { if (onPick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(s.id) } }}
                    className={cn(onPick && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", focus === s.id && "bg-muted")}
                  >
                    <TableCell className="font-medium">
                      {s.name}
                      <span className="block text-xs font-normal text-muted-foreground">{s.city}</span>
                    </TableCell>
                    <TableCell>{s.region}</TableCell>
                    <TableCell>
                      <Badge variant={m.badge} className={cn("gap-1", m.tone)}>
                        <m.Icon className="size-3" aria-hidden />
                        {m.label}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.units_at_risk ? m.text : "text-muted-foreground")}>{s.units_at_risk ? fmt(s.units_at_risk) : "0"}</TableCell>
                    <TableCell className="min-w-64 whitespace-normal text-xs text-muted-foreground">
                      {w.text}
                      {"path" in w && w.path ? (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="h-auto border-chart-3/60 font-mono text-[11px] whitespace-normal text-chart-3">{w.path}</Badge>
                          {w.extra ? <span>+{w.extra} more {w.extra === 1 ? "path" : "paths"}</span> : null}
                        </span>
                      ) : null}
                    </TableCell>
                    {notices && <TableCell className="text-xs">{notices.get(s.id) ? <Badge variant={notices.get(s.id) === "approved" ? "default" : "outline"}>{NOTICE[notices.get(s.id)!]}</Badge> : <span className="text-muted-foreground">None needed</span>}</TableCell>}
                  </TableRow>
                </GroupedRow>
              )
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>{rows.length} of {counts.all} stores</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(shownUnits)}</TableCell>
              <TableCell colSpan={cols - 4} className="text-xs font-normal text-muted-foreground">units to pull in this view</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </div>
  )
}

/** Emits a decision header row before the first row of each group when `header` is set. */
function GroupedRow({ header, cols, children }: { header: { status: Status; n: number } | null; cols: number; children: React.ReactNode }) {
  if (!header) return <>{children}</>
  const m = META[header.status]
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={cols} className={cn("py-1.5 text-xs font-semibold", m.text)}>
          <span className="inline-flex items-center gap-1.5"><m.Icon className="size-3.5" aria-hidden />{m.label} · {header.n} {header.n === 1 ? "store" : "stores"}</span>
        </TableCell>
      </TableRow>
      {children}
    </>
  )
}
