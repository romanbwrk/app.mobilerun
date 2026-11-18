import { afterAll, describe, expect, it } from "vitest"

/**
 * Runs the channel service against a real mcpocket in a temporary tube that is
 * force-deleted at the end. Opt-in: set MCPOCKET_LIVE_KEY (operator role) and,
 * optionally, MCPOCKET_LIVE_URL. Overrides the fake the shared setup started.
 */
const key = process.env.MCPOCKET_LIVE_KEY
if (key) {
  process.env.MCPOCKET_API_KEY = key
  process.env.MCPOCKET_URL =
    process.env.MCPOCKET_LIVE_URL ?? "https://app.mcpocket.io/api/mcp"
  process.env.MCPOCKET_AGENT_ID = `mobilerun-smoke-${process.pid}`
}

describe.skipIf(!key)("mcpocket live smoke", () => {
  const name = `mobilerun-smoke-${Date.now()}`
  let tubeId: string | null = null

  afterAll(async () => {
    if (!tubeId) return
    const { deleteChannel } = await import("@/lib/db-channels")
    await deleteChannel(tubeId).catch(() => undefined)
  })

  it("connects with an operator key that has every tool", async () => {
    const { getMcpocketStatus } = await import("@/lib/mcpocket/status")
    const status = await getMcpocketStatus()
    expect(status).toMatchObject({ ok: true, missingTools: [] })
  })

  it("runs the channel lifecycle end to end", async () => {
    const db = await import("@/lib/db-channels")
    const created = await db.createChannel({ name, description: "smoke" })
    tubeId = created.id
    await expect(db.createChannel({ name })).rejects.toMatchObject({
      code: "conflict",
    })

    const added = await db.addRecords(name, [{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(added.map((r) => r.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect((await db.peekNextRecord(tubeId))?.id).toBe(added[0].id)
    expect(await db.hasPendingRecord(tubeId)).toBe(true)

    // Claim, undo back to the front, claim again.
    const first = await db.claimNextRecord(name)
    expect(first).toMatchObject({ id: added[0].id, status: "processing" })
    expect((await db.undoRecord(name, first!.id)).status).toBe("pending")
    expect((await db.claimNextRecord(tubeId))?.id).toBe(added[0].id)

    // Settle as a run would: complete, then a manual change blocks a late settle.
    expect(
      await db.settleRecord(added[0].id, {
        status: "completed",
        result: { runId: "smoke", success: true },
      })
    ).toBe(true)
    const second = await db.claimNextRecord(tubeId)
    await db.updateRecord(tubeId, second!.id, { status: "cancelled" })
    expect(
      await db.settleRecord(second!.id, { status: "failed", result: {} })
    ).toBe(false)
    const failedRun = await db.claimNextRecord(tubeId)
    expect(
      await db.settleRecord(failedRun!.id, {
        status: "failed",
        result: { runId: "smoke", reason: "boom" },
      })
    ).toBe(true)
    expect(await db.getRecord(tubeId, failedRun!.id)).toMatchObject({
      status: "failed",
      error: "boom",
    })

    // Worker set with the legacy "done" alias and a result.
    const set = await db.setRecord(name, second!.id, {
      status: "done",
      result: { v: 1 },
    })
    expect(set).toMatchObject({ status: "completed", result: { v: 1 } })

    const channel = await db.getChannel(tubeId)
    expect(channel.counts).toMatchObject({ completed: 2, failed: 1 })
    const page = await db.listRecords(tubeId, { status: "completed" })
    expect(page.total).toBe(2)

    const exported = await db.exportRecords(tubeId, {})
    const rows: unknown[] = []
    for await (const o of exported.objects) rows.push(o)
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])

    await db.addRecords(tubeId, { n: 4 })
    await db.claimNextRecord(tubeId)
    expect(
      await db.bulkRecords(tubeId, { action: "reset_processing" })
    ).toEqual({ affected: 1 })
    expect(
      await db.bulkRecords(tubeId, {
        action: "delete_by_status",
        status: "completed",
      })
    ).toEqual({ affected: 2 })

    const removed = await db.deleteChannel(tubeId)
    expect(removed.deletedRecords).toBe(2)
    tubeId = null
    await expect(db.getChannel(name)).rejects.toMatchObject({
      code: "not_found",
    })
  })
})
