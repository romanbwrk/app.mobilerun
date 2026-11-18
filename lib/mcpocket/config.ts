import { connectDb } from "@/lib/db"
import { Settings, SETTINGS_ID, type SettingsDoc } from "@/lib/models/settings"

export const DEFAULT_MCPOCKET_URL = "https://app.mcpocket.io/api/mcp"
export const DEFAULT_MCPOCKET_AGENT_ID = "mobilerun"

export type McpocketConfig = {
  url: string
  apiKey: string | null
  agentId: string
  /** Where the API key came from: the Settings page, the environment, or nowhere. */
  keySource: "settings" | "env" | null
}

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/**
 * The mcpocket connection: values saved on the Settings page win, then the
 * MCPOCKET_URL / MCPOCKET_API_KEY / MCPOCKET_AGENT_ID environment variables,
 * then the defaults. Read on every call so a key saved in the UI applies at once.
 */
export async function getMcpocketConfig(): Promise<McpocketConfig> {
  await connectDb()
  const doc = await Settings.findById(SETTINGS_ID)
    .select("mcpocketUrl mcpocketApiKey mcpocketAgentId")
    .lean<Partial<SettingsDoc>>()
  return resolveMcpocketConfig(doc ?? {})
}

export function resolveMcpocketConfig(
  doc: Partial<
    Pick<SettingsDoc, "mcpocketUrl" | "mcpocketApiKey" | "mcpocketAgentId">
  >
): McpocketConfig {
  const savedKey = clean(doc.mcpocketApiKey)
  const envKey = clean(process.env.MCPOCKET_API_KEY)
  return {
    url:
      clean(doc.mcpocketUrl) ||
      clean(process.env.MCPOCKET_URL) ||
      DEFAULT_MCPOCKET_URL,
    apiKey: savedKey || envKey || null,
    agentId:
      clean(doc.mcpocketAgentId) ||
      clean(process.env.MCPOCKET_AGENT_ID) ||
      DEFAULT_MCPOCKET_AGENT_ID,
    keySource: savedKey ? "settings" : envKey ? "env" : null,
  }
}
