import type mongoose from "mongoose"

import { settleRecord, type SettleRecordOutcome } from "@/lib/db-channels"
import { Run } from "@/lib/models/run"

type SettleSource = {
  status: string
  dbRecord?: { channel: string; recordId: unknown } | null
  result?: { success?: boolean; reason?: string; steps?: number } | null
  error?: string | null
}

/** What a run's final status does to the record it claimed; null while the run is not terminal. */
function outcomeFor(
  runId: string,
  run: SettleSource
): SettleRecordOutcome | null {
  const steps = run.result?.steps ?? 0
  switch (run.status) {
    case "succeeded":
      return {
        status: "completed",
        result: {
          runId,
          success: true,
          reason: run.result?.reason ?? "",
          steps,
        },
      }
    case "failed":
      return {
        status: "failed",
        result: {
          runId,
          success: false,
          reason: run.result?.reason || run.error || "",
          steps,
        },
      }
    case "cancelled":
    case "lost":
    case "skipped":
      return { status: "pending" }
    default:
      return null
  }
}

/**
 * Settles the channel record (mcpocket item) a run claimed, from the run's
 * final status: succeeded completes it, failed fails it, and a run that did
 * not process it (cancelled, lost, skipped) releases it back to the queue at
 * its original position. mcpocket only lets the lease holder do this while
 * the record is still processing, so a change an operator made by hand wins.
 * Idempotent and never throws: a settle failure is logged, not propagated
 * into the run's own bookkeeping.
 */
export async function settleChannelRecord(
  runId: mongoose.Types.ObjectId
): Promise<void> {
  try {
    const run = await Run.findById(runId)
      .select("status dbRecord result error")
      .lean<SettleSource>()
    if (!run?.dbRecord) return
    const outcome = outcomeFor(runId.toString(), run)
    if (!outcome) return
    await settleRecord(String(run.dbRecord.recordId), outcome)
  } catch (err) {
    console.error(`[db-channel] could not settle record for run ${runId}`, err)
  }
}
