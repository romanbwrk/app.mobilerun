import { visibleStatuses } from "@/components/db/format"
import type { StatusCounts } from "@/lib/db-channels"

/** Compact "pending 3 · processing 1 · completed 0 · failed 0" strip; rarer statuses only when present. */
export function StatusCountsRow({
  counts,
  className,
}: {
  counts: StatusCounts
  className?: string
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {visibleStatuses(counts).map((s) => (
          <span key={s} className="whitespace-nowrap">
            <span className="text-muted-foreground">{s}</span>{" "}
            <span className="font-medium tabular-nums">{counts[s]}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
