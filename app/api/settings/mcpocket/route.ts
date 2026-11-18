import { route } from "@/lib/api/route"
import { getMcpocketStatus } from "@/lib/mcpocket/status"

/** Connection check for the Settings page: `{ status: McpocketStatus }`. */
export const GET = route(async () =>
  Response.json({ status: await getMcpocketStatus() })
)
