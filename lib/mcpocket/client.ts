import { ApiError } from "@/lib/api/errors"
import { getMcpocketConfig, type McpocketConfig } from "@/lib/mcpocket/config"

/**
 * Thin client for mcpocket's MCP endpoint. The server is stateless JSON-RPC
 * over HTTP (no session), so every call is one POST: `tools/call` for tools,
 * `resources/read` for resources. Failures come back as `ApiError`s, so route
 * handlers turn them into the usual `{ error: { code, message } }` envelope.
 */

const TIMEOUT_MS = 20_000

/** mcpocket's entity names, as this app calls them. */
const ENTITY_NAMES: Record<string, string> = {
  Tube: "Channel",
  Item: "Record",
  Folder: "Folder",
}

type McpError = {
  code?: string
  message?: string
  details?: unknown
}

let nextId = 1

function notConfigured(): ApiError {
  return new ApiError(
    "mcpocket_not_configured",
    "mcpocket is not configured: add an operator API key in Settings",
    503
  )
}

/** Maps mcpocket's `{ error: { code, message, details } }` onto this app's errors. */
export function toApiError(err: McpError | undefined): ApiError {
  const code = err?.code ?? "internal_error"
  const message = err?.message ?? "mcpocket request failed"
  switch (code) {
    case "not_found": {
      const entity =
        typeof err?.details === "object" && err.details !== null
          ? (err.details as { entity?: string }).entity
          : undefined
      const what = entity ? (ENTITY_NAMES[entity] ?? entity) : null
      return new ApiError(
        "not_found",
        what ? `${what} not found` : message,
        404
      )
    }
    case "conflict":
      return new ApiError("conflict", message, 409)
    case "validation_error": {
      const details = Array.isArray(err?.details)
        ? (err.details as { path?: string; message?: string }[])
            .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
            .filter(Boolean)
            .join("; ")
        : ""
      return new ApiError(
        "validation_error",
        details ? `${message}: ${details}` : message,
        400
      )
    }
    case "payload_too_large":
      return new ApiError("validation_error", message, 413)
    case "rate_limited":
      return new ApiError("rate_limited", `mcpocket: ${message}`, 429)
    case "unauthorized":
    case "forbidden":
      return new ApiError(
        "mcpocket_error",
        `mcpocket refused the API key (${code}): ${message}`,
        502
      )
    default:
      return new ApiError("mcpocket_error", `mcpocket: ${message}`, 502)
  }
}

/** Reads a JSON-RPC response that may arrive as plain JSON or as one SSE event. */
async function readRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .pop()
    if (!data)
      throw new ApiError("mcpocket_error", "Empty mcpocket stream", 502)
    return JSON.parse(data)
  }
  return JSON.parse(text)
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  config?: McpocketConfig
): Promise<Record<string, unknown>> {
  const cfg = config ?? (await getMcpocketConfig())
  if (!cfg.apiKey) throw notConfigured()
  let res: Response
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "x-agent-id": cfg.agentId,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ApiError("mcpocket_error", `mcpocket unreachable: ${reason}`, 502)
  }
  if (res.status === 401 || res.status === 403)
    throw new ApiError(
      "mcpocket_error",
      `mcpocket refused the API key (HTTP ${res.status})`,
      502
    )
  if (res.status === 429)
    throw new ApiError("rate_limited", "mcpocket rate limit reached", 429)
  let body: Record<string, unknown>
  try {
    body = await readRpc(res)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(
      "mcpocket_error",
      `mcpocket answered HTTP ${res.status} with an unreadable body`,
      502
    )
  }
  if (body.error) {
    const e = body.error as { message?: string; data?: { error?: McpError } }
    throw toApiError(e.data?.error ?? { message: e.message })
  }
  return (body.result ?? {}) as Record<string, unknown>
}

/** Calls an mcpocket tool and returns its JSON result. */
export async function callTool<T>(
  name: string,
  args: Record<string, unknown> = {},
  config?: McpocketConfig
): Promise<T> {
  const result = await rpc("tools/call", { name, arguments: args }, config)
  let out = result.structuredContent as unknown
  if (out === undefined) {
    const content = result.content as { type: string; text?: string }[]
    const text = content?.find((c) => c.type === "text")?.text ?? "null"
    try {
      out = JSON.parse(text)
    } catch {
      out = { error: { code: "internal_error", message: text } }
    }
  }
  if (result.isError) {
    const err = (out as { error?: McpError } | null)?.error
    throw toApiError(err)
  }
  return out as T
}

/** Reads an mcpocket resource (`mcpocket://...`) and returns its parsed JSON. */
export async function readResource<T>(
  uri: string,
  config?: McpocketConfig
): Promise<T> {
  const result = await rpc("resources/read", { uri }, config)
  const contents = result.contents as { text?: string }[] | undefined
  return JSON.parse(contents?.[0]?.text ?? "null") as T
}
