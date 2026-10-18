import { redirect } from "next/navigation";
import type { RecallResult, TraceEvent } from "@server/agent/run";
import type { IncidentReport } from "@server/tools/incident";
import type { Notice } from "@server/tools/index";
import { api, apiOrNull, LOT_RE } from "@/lib/api";
import { IncidentClient } from "./incident-client";
import type { Initial, Status } from "./incident-view";

export async function generateMetadata({ params }: PageProps<"/incident/[lot]">) {
  const { lot } = await params;
  const code = decodeURIComponent(lot);
  return { title: `Incident ${code}`, description: `Which stores pull lot ${code}, which are cleared and why: every decision traced through the FalkorDB graph, with the agent's steps and queries.` };
}

export default async function Page({ params, searchParams }: PageProps<"/incident/[lot]">) {
  const { lot } = await params;
  const { hazard, start, replay } = await searchParams;
  // A bad or unknown lot goes back to the lookup, which says what is wrong next to the field.
  if (!LOT_RE.test(lot)) redirect(`/incident?lot=${encodeURIComponent(lot)}`);
  const autostart = start === "1";
  // A fresh run starts empty; otherwise everything is read on the server, in parallel, so a reload never reruns the agent.
  const initial: Initial = autostart ? { run: null, report: null, status: null, notices: [] } : await load(lot);
  // Keyed by lot: following a link to another lot gets a fresh dashboard, never the last lot's state.
  return <IncidentClient key={lot} lot={lot} hazard={typeof hazard === "string" ? hazard : undefined} autostart={autostart} playback={!autostart && replay === "1"} initial={initial} />;
}

type Recording = { events: { event: TraceEvent }[] };

/** Any lot with an incident shows its dashboard, not only the lot of the last run. */
async function load(lot: string): Promise<Initial> {
  const [last, status, notices, recording] = await Promise.all([
    apiOrNull<RecallResult>("/recall/last"),
    apiOrNull<Status>(`/incident/${lot}/status`),
    api<Notice[]>("/notices"),
    apiOrNull<Recording>(`/recall/replay?lot=${lot}&format=json`),
  ]);
  if (!status) redirect(`/incident?lot=${lot}`);
  if (!status.incident) return { run: null, report: null, status, notices: [] };
  // The agent log: the latest live run if it was this lot, else the run the server recorded for it.
  const done = recording?.events.findLast((e) => e.event.type === "done")?.event;
  const run = last?.lot === lot ? last : done?.type === "done" ? done.result : null;
  const report = await api<IncidentReport>(`/incident/${lot}${run?.add_gap_stores === false ? "?gaps=flag" : ""}`);
  return { run, report, status, notices: notices.filter((n) => n.lot === lot) };
}
