import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4" aria-busy="true" aria-label="Loading the incident">
      <Skeleton className="h-32 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
    </div>
  );
}
