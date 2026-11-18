import { ApiError } from "@/lib/api/errors"
import { readResource } from "@/lib/mcpocket/client"

/** Every mcpocket tool the Database section and channel-bound runs call. */
export const REQUIRED_MCPOCKET_TOOLS = [
  "get_folder_tree",
  "list_tubes",
  "create_tube",
  "update_tube",
  "delete_tube",
  "get_tube_statistics",
  "bulk_push_items",
  "get_item",
  "update_item",
  "delete_item",
  "list_items",
  "bulk_update_items",
  "bulk_delete_items",
  "claim_next_item",
  "complete_item",
  "fail_item",
  "release_item",
] as const

export type McpocketStatus =
  | {
      ok: true
      server: string
      workspace: string | null
      role: string | null
      scoped: boolean
      agentId: string | null
      /** Required tools the key's role does not offer; empty when all is well. */
      missingTools: string[]
    }
  | { ok: false; code: string; message: string }

type SystemInfo = {
  data: {
    server?: { name?: string; version?: string }
    you?: {
      id?: string
      workspace?: string
      access?: { role?: string; scope?: unknown }
    }
    tools?: string[]
  }
}

/** Probes mcpocket with the configured key: who it is, and whether it can do everything this app needs. */
export async function getMcpocketStatus(): Promise<McpocketStatus> {
  try {
    const info = await readResource<SystemInfo>("mcpocket://system/info")
    const d = info.data
    const tools = new Set(d.tools ?? [])
    return {
      ok: true,
      server: [d.server?.name, d.server?.version].filter(Boolean).join(" "),
      workspace: d.you?.workspace ?? null,
      role: d.you?.access?.role ?? null,
      scoped: d.you?.access?.scope != null,
      agentId: d.you?.id ?? null,
      missingTools: REQUIRED_MCPOCKET_TOOLS.filter((t) => !tools.has(t)),
    }
  } catch (err) {
    if (err instanceof ApiError)
      return { ok: false, code: err.code, message: err.message }
    return {
      ok: false,
      code: "mcpocket_error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
