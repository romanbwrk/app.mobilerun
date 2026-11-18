/** Record (mcpocket item) lifecycle states, safe to import from client components. */
export const DB_RECORD_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
  "cancelled",
  "archived",
] as const
export type DbRecordStatus = (typeof DB_RECORD_STATUSES)[number]

/** Statuses an operator or worker may set by hand: only a claim starts processing. */
export const SETTABLE_RECORD_STATUSES = DB_RECORD_STATUSES.filter(
  (s) => s !== "processing"
) as Exclude<DbRecordStatus, "processing">[]

/**
 * The pre-mcpocket name for `completed`, still accepted from workers so
 * existing `set` calls with `{ status: "done" }` keep working.
 */
export function normalizeRecordStatus(value: unknown): unknown {
  return value === "done" ? "completed" : value
}
