import { cn } from "@/lib/utils";

/** A headline figure in the incident dashboard's style: label on top, a big number with a small qualifier, one short line under it. */
export function StatTile({ label, value, unit, foot, tone, className, children }: {
  label: string; value: React.ReactNode; unit?: React.ReactNode; foot?: React.ReactNode; tone?: string; className?: string; children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col rounded-2xl bg-card p-4 ring-1 ring-foreground/7 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.03)]", className)}>
      <p className="text-[0.95rem] text-foreground/90">{label}</p>
      <p className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-4">
        <span className="text-4xl font-medium tracking-tight tabular-nums">{value}</span>
        {unit && <span className={cn("text-sm font-medium", tone ?? "text-muted-foreground")}>{unit}</span>}
      </p>
      {foot && <p className="mt-1.5 text-xs text-muted-foreground">{foot}</p>}
      {children}
    </div>
  );
}
