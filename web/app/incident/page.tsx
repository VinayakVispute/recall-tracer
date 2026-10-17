import Link from "next/link";
import { redirect } from "next/navigation";
import type { RecallResult } from "@server/agent/run";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { apiOrNull } from "@/lib/api";

/** The Incident tab: the incident under review, or the way to open one. */
export default async function Page() {
  const last = await apiOrNull<RecallResult>("/recall/last");
  if (last) redirect(`/incident/${last.lot}`);
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No incident open</EmptyTitle>
          <EmptyDescription>An incident starts from an outbreak cluster or a supplier&apos;s notice. The seeded example is ready to run.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center gap-2">
          <Link href="/outbreak" className={buttonVariants()}>Find the source of an outbreak</Link>
          <Link href="/notice?lot=L-204" className={buttonVariants({ variant: "outline" })}>Supplier notice for L-204</Link>
        </EmptyContent>
      </Empty>
    </div>
  );
}
