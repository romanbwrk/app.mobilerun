import { Badge } from "@/components/ui/badge"
import type { DbRecordStatus } from "@/lib/db-record-status"

const variants: Record<
  DbRecordStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  processing: "default",
  completed: "secondary",
  failed: "destructive",
  retry: "outline",
  cancelled: "outline",
  archived: "outline",
}

export function DbStatusBadge({ status }: { status: DbRecordStatus }) {
  return <Badge variant={variants[status] ?? "outline"}>{status}</Badge>
}
