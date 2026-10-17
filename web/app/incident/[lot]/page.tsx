import { notFound } from "next/navigation";
import type { RecallResult } from "@server/agent/run";
import type { IncidentReport } from "@server/tools/incident";
import type { Notice } from "@server/tools/index";
import { api, apiOrNull, LOT_RE } from "@/lib/api";
import { IncidentClient } from "./incident-client";
import type { Initial, Status } from "./incident-view";

export default async function Page({ params, searchParams }: PageProps<"/incident/[lot]">) {
  const { lot } = await params;
  const { hazard, start, replay } = await searchParams;
  if (!LOT_RE.test(lot)) notFound();
  const autostart = start === "1";
  // A fresh run starts empty; otherwise everything is read on the server, in parallel, so a reload never reruns the agent.
  const initial: Initial = autostart ? { run: null, report: null, status: null, notices: [] } : await load(lot);
  return <IncidentClient lot={lot} hazard={typeof hazard === "string" ? hazard : undefined} autostart={autostart} playback={!autostart && replay === "1"} initial={initial} />;
}

async function load(lot: string): Promise<Initial> {
  const [last, status, notices] = await Promise.all([
    apiOrNull<RecallResult>("/recall/last"),
    apiOrNull<Status>(`/incident/${lot}/status`),
    api<Notice[]>("/notices"),
  ]);
  if (!status) notFound(); // unknown lot
  const run = last?.lot === lot ? last : null;
  const report = run ? await api<IncidentReport>(`/incident/${lot}${run.add_gap_stores === false ? "?gaps=flag" : ""}`) : null;
  return { run, report, status, notices: notices.filter((n) => n.lot === lot) };
}
