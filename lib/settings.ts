import { z } from "zod"

import { connectDb } from "@/lib/db"
import { resolveMcpocketConfig } from "@/lib/mcpocket/config"
import {
  PROMPT_ROLES,
  Settings,
  SETTINGS_ID,
  type SettingsDoc,
} from "@/lib/models/settings"

export type SettingsView = {
  screenshotIntervalMs: number
  screenshotRetentionRuns: number
  maxDeviceTemperatureC: number
  minBatteryLevel: number
  deviceCooldownSeconds: number
  prompts: Record<string, string>
  mcpocket: McpocketSettingsView
}

/** The mcpocket connection as the UI may see it: never the key itself. */
export type McpocketSettingsView = {
  url: string
  agentId: string
  /** What is saved on the Settings page; empty means the env / default applies. */
  saved: { url: string; agentId: string }
  apiKeySet: boolean
  /** Last four characters of the key in use, for recognising it. */
  apiKeyHint: string | null
  keySource: "settings" | "env" | null
}

function toMcpocketView(doc: SettingsDoc): McpocketSettingsView {
  const cfg = resolveMcpocketConfig(doc)
  return {
    url: cfg.url,
    agentId: cfg.agentId,
    saved: {
      url: doc.mcpocketUrl ?? "",
      agentId: doc.mcpocketAgentId ?? "",
    },
    apiKeySet: Boolean(cfg.apiKey),
    apiKeyHint: cfg.apiKey ? cfg.apiKey.slice(-4) : null,
    keySource: cfg.keySource,
  }
}

function toView(doc: SettingsDoc): SettingsView {
  const prompts = (doc.prompts as Record<string, string> | undefined) ?? {}
  return {
    screenshotIntervalMs: doc.screenshotIntervalMs,
    screenshotRetentionRuns: doc.screenshotRetentionRuns,
    maxDeviceTemperatureC: doc.maxDeviceTemperatureC ?? 42,
    minBatteryLevel: doc.minBatteryLevel ?? 30,
    deviceCooldownSeconds: doc.deviceCooldownSeconds ?? 300,
    prompts: Object.fromEntries(
      Object.entries(prompts).filter(
        ([, v]) => typeof v === "string" && v.trim() !== ""
      )
    ),
    mcpocket: toMcpocketView(doc),
  }
}

export async function getSettings(): Promise<SettingsView> {
  await connectDb()
  const existing = await Settings.findById(SETTINGS_ID).lean<SettingsDoc>()
  if (existing) return toView(existing)
  const doc = await Settings.findOneAndUpdate(
    { _id: SETTINGS_ID },
    { $setOnInsert: { _id: SETTINGS_ID } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<SettingsDoc>()
  return toView(doc!)
}

export const updateSettingsSchema = z
  .object({
    screenshotIntervalMs: z.number().int().min(500).max(60_000),
    screenshotRetentionRuns: z.number().int().min(0).max(1000),
    maxDeviceTemperatureC: z.number().min(0).max(100),
    minBatteryLevel: z.number().int().min(0).max(100),
    deviceCooldownSeconds: z.number().int().min(30).max(86_400),
    prompts: z.partialRecord(z.enum(PROMPT_ROLES), z.string().max(50_000)),
    /** Empty string clears it, so the MCPOCKET_URL env / default applies. */
    mcpocketUrl: z.union([z.literal(""), z.url()]),
    /** Empty string clears the saved key. */
    mcpocketApiKey: z.string().trim().max(500),
    mcpocketAgentId: z.union([
      z.literal(""),
      z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9._:@-]{1,128}$/,
          "Agent id: letters, digits and . _ : @ - only"
        ),
    ]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No settings provided" })

export async function updateSettings(input: unknown): Promise<SettingsView> {
  const patch = updateSettingsSchema.parse(input)
  await connectDb()
  const $set: Record<string, unknown> = { ...patch }
  if (patch.prompts) {
    $set.prompts = Object.fromEntries(
      Object.entries(patch.prompts).filter(([, v]) => v.trim() !== "")
    )
  }
  const doc = await Settings.findOneAndUpdate(
    { _id: SETTINGS_ID },
    { $set, $setOnInsert: { _id: SETTINGS_ID } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<SettingsDoc>()
  const view = toView(doc!)
  if (patch.screenshotRetentionRuns !== undefined) {
    const { applyScreenshotRetention } = await import("@/lib/runs/screenshots")
    await applyScreenshotRetention(null, view.screenshotRetentionRuns)
  }
  return view
}
