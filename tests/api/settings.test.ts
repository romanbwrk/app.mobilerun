import { describe, expect, it } from "vitest"

async function get() {
  const { GET } = await import("@/app/api/settings/route")
  const res = await GET(new Request("http://app/api/settings"), {})
  return { status: res.status, body: await res.json() }
}

async function patch(payload: unknown) {
  const { PATCH } = await import("@/app/api/settings/route")
  const res = await PATCH(
    new Request("http://app/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    {}
  )
  return { status: res.status, body: await res.json() }
}

describe("settings", () => {
  it("returns defaults before anything is saved", async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.settings).toEqual({
      screenshotIntervalMs: 2000,
      screenshotRetentionRuns: 20,
      maxDeviceTemperatureC: 42,
      minBatteryLevel: 30,
      deviceCooldownSeconds: 300,
      prompts: {},
      // Tests reach the fake mcpocket through the MCPOCKET_* env fallback.
      mcpocket: {
        url: process.env.MCPOCKET_URL,
        agentId: "mobilerun",
        saved: { url: "", agentId: "" },
        apiKeySet: true,
        apiKeyHint: process.env.MCPOCKET_API_KEY!.slice(-4),
        keySource: "env",
      },
    })
  })

  it("saves the mcpocket key server-side and never returns it", async () => {
    const res = await patch({
      mcpocketApiKey: "mcp_saved_key_9876",
      mcpocketAgentId: "farm-1",
    })
    expect(res.status).toBe(200)
    expect(res.body.settings.mcpocket).toMatchObject({
      agentId: "farm-1",
      saved: { url: "", agentId: "farm-1" },
      apiKeySet: true,
      apiKeyHint: "9876",
      keySource: "settings",
    })
    expect(JSON.stringify(res.body)).not.toContain("mcp_saved_key_9876")
    const { getMcpocketConfig } = await import("@/lib/mcpocket/config")
    expect(await getMcpocketConfig()).toMatchObject({
      apiKey: "mcp_saved_key_9876",
      agentId: "farm-1",
    })

    // Clearing the saved values falls back to the environment again.
    const cleared = await patch({ mcpocketApiKey: "", mcpocketAgentId: "" })
    expect(cleared.body.settings.mcpocket).toMatchObject({
      agentId: "mobilerun",
      keySource: "env",
    })
    expect((await patch({ mcpocketUrl: "not a url" })).status).toBe(400)
    expect((await patch({ mcpocketAgentId: "bad id!" })).status).toBe(400)
  })

  it("reports the mcpocket connection and any missing tools", async () => {
    const { GET } = await import("@/app/api/settings/mcpocket/route")
    const res = await GET(new Request("http://app/api/settings/mcpocket"), {})
    expect((await res.json()).status).toMatchObject({
      ok: true,
      role: "operator",
      workspace: "test",
      missingTools: [],
    })
  })

  it("updates a subset of settings and keeps the rest", async () => {
    const { status, body } = await patch({ screenshotIntervalMs: 5000 })
    expect(status).toBe(200)
    expect(body.settings).toMatchObject({
      screenshotIntervalMs: 5000,
      screenshotRetentionRuns: 20,
    })
    expect((await get()).body.settings.screenshotIntervalMs).toBe(5000)
  })

  it("rejects out-of-range and empty updates", async () => {
    expect((await patch({ screenshotIntervalMs: 100 })).status).toBe(400)
    expect((await patch({ screenshotRetentionRuns: -1 })).status).toBe(400)
    expect((await patch({ maxDeviceTemperatureC: 101 })).status).toBe(400)
    expect((await patch({ minBatteryLevel: 101 })).status).toBe(400)
    expect((await patch({ deviceCooldownSeconds: 5 })).status).toBe(400)
    const empty = await patch({})
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe("validation_error")
  })

  it("stores prompt overrides with validation", async () => {
    const ok = await patch({
      prompts: { manager_system: "Be terse.", executor_system: "" },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.settings.prompts).toEqual({ manager_system: "Be terse." })

    expect((await patch({ prompts: { bogus_role: "x" } })).status).toBe(400)
  })
})
