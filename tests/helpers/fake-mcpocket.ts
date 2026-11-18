import { randomUUID } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * In-memory stand-in for mcpocket's MCP endpoint (stateless JSON-RPC over
 * HTTP). It implements the tools mobilerun calls with the semantics verified
 * against the live server: never-expiring leases (leaseSeconds 0), manual
 * status changes that revoke the lease, lease-holder checks answering
 * `conflict`, retry policy on fail, bulk filter updates and deletes.
 */

type Tube = {
  id: string
  folderId: string | null
  name: string
  description?: string
  enabled: boolean
  leaseSeconds: number | null
  maxAttempts: number
  createdAt: string
  updatedAt: string
}

type Item = {
  id: string
  tubeId: string
  seq: number
  status: string
  payload: Record<string, unknown>
  result?: unknown
  lastError?: { message: string } | null
  priority: number
  assignedAgent: string | null
  leaseExpiresAt: string | null
  /** Whether the current assignedAgent holds a live lease. */
  leased: boolean
  attempts: number
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

const STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "retry",
  "cancelled",
  "archived",
]
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message)
  }
}

const notFound = (entity: string, id: string) =>
  new ToolError("not_found", `${entity} "${id}" not found`, { entity, id })
const conflict = (message: string) => new ToolError("conflict", message)
const invalid = (message: string) => new ToolError("validation_error", message)

export type FakeMcpocket = {
  url: string
  apiKey: string
  tubes: Map<string, Tube>
  items: Map<string, Item>
  /** Every tool name called, in order. */
  calls: string[]
  /** Calls a tool directly, as another agent would. */
  call: (name: string, args: Record<string, unknown>, agent?: string) => unknown
  close: () => Promise<void>
}

export async function startFakeMcpocket(
  apiKey = "mcp_test_key"
): Promise<FakeMcpocket> {
  const tubes = new Map<string, Tube>()
  const items = new Map<string, Item>()
  const calls: string[] = []
  let seq = 0
  const now = () => new Date().toISOString()

  const view = (i: Item) => {
    const { seq: _seq, leased: _leased, ...rest } = i
    void _seq
    void _leased
    return rest
  }
  const tubeView = (t: Tube) => {
    const { maxAttempts: _m, ...rest } = t
    void _m
    return rest
  }
  const live = (tubeId: string) =>
    [...items.values()]
      .filter((i) => i.tubeId === tubeId && !i.deletedAt)
      .sort((a, b) => a.seq - b.seq)
  const statusList = (v: unknown): string[] | null => {
    if (v === undefined || v === null) return null
    const list = Array.isArray(v) ? v : String(v).split(",")
    return list.map((s) => String(s).trim())
  }
  const counts = (tubeId: string) => {
    const c: Record<string, number> = Object.fromEntries(
      STATUSES.map((s) => [s, 0])
    )
    for (const i of live(tubeId)) c[i.status]++
    return c
  }
  const tube = (id: unknown): Tube => {
    if (typeof id !== "string" || !UUID_RE.test(id))
      throw invalid("Invalid UUID")
    const t = tubes.get(id)
    if (!t) throw notFound("Tube", id)
    return t
  }
  const item = (id: unknown): Item => {
    if (typeof id !== "string" || !UUID_RE.test(id))
      throw invalid("Invalid UUID")
    const i = items.get(id)
    if (!i) throw notFound("Item", id)
    return i
  }
  const holder = (i: Item, agent: string) => {
    if (
      i.deletedAt ||
      i.status !== "processing" ||
      !i.leased ||
      i.assignedAgent !== agent
    )
      throw conflict(`You do not hold a live lease on item "${i.id}"`)
  }
  const push = (tubeId: string, payload: unknown): Item => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    )
      throw invalid("payload must be an object")
    const t = now()
    const it: Item = {
      id: randomUUID(),
      tubeId,
      seq: seq++,
      status: "pending",
      payload: payload as Record<string, unknown>,
      priority: 0,
      assignedAgent: null,
      leaseExpiresAt: null,
      leased: false,
      attempts: 0,
      deletedAt: null,
      createdAt: t,
      updatedAt: t,
    }
    items.set(it.id, it)
    return it
  }
  const applyPatch = (i: Item, patch: Record<string, unknown>) => {
    if (patch.status !== undefined) {
      const s = String(patch.status)
      if (!STATUSES.includes(s)) throw invalid(`Unknown status ${s}`)
      if (s === "processing")
        throw invalid("only claim_next_item starts processing")
      i.status = s
      i.leased = false
      i.leaseExpiresAt = null
      if (s === "pending") i.assignedAgent = null
    }
    if (patch.payload !== undefined)
      i.payload = patch.payload as Record<string, unknown>
    if ("result" in patch) i.result = patch.result ?? undefined
    i.updatedAt = now()
  }

  const tools: Record<
    string,
    (a: Record<string, unknown>, agent: string) => unknown
  > = {
    get_folder_tree: () => ({
      data: [],
      rootTubes: [...tubes.values()].map(tubeView),
    }),
    list_tubes: (a) => {
      let list = [...tubes.values()]
      if (a.name !== undefined) list = list.filter((t) => t.name === a.name)
      const offset = Number(a.offset ?? 0)
      const limit = Number(a.limit ?? 100)
      return {
        data: list.slice(offset, offset + limit).map((t) => ({
          ...tubeView(t),
          ...(a.withCounts ? { counts: counts(t.id) } : {}),
        })),
        page: { offset, limit, total: list.length },
      }
    },
    create_tube: (a) => {
      const t = now()
      const created: Tube = {
        id: randomUUID(),
        folderId: (a.folderId as string) ?? null,
        name: String(a.name),
        ...(a.description ? { description: String(a.description) } : {}),
        enabled: true,
        leaseSeconds: (a.leaseSeconds as number) ?? null,
        maxAttempts:
          (a.retryPolicy as { maxAttempts?: number } | undefined)
            ?.maxAttempts ?? 3,
        createdAt: t,
        updatedAt: t,
      }
      tubes.set(created.id, created)
      return { data: tubeView(created) }
    },
    update_tube: (a) => {
      const t = tube(a.id)
      if (a.name !== undefined) t.name = String(a.name)
      if (a.description !== undefined)
        t.description =
          a.description === null ? undefined : String(a.description)
      t.updatedAt = now()
      return { data: tubeView(t) }
    },
    delete_tube: (a) => {
      const t = tube(a.id)
      const its = live(t.id)
      if (its.length > 0 && !a.force) throw conflict("Tube is not empty")
      for (const i of its) i.deletedAt = now()
      tubes.delete(t.id)
      return { deleted: true, id: t.id, deletedItems: its.length }
    },
    get_tube_statistics: (a) => {
      const t = tube(a.id)
      return {
        data: {
          tubeId: t.id,
          tubeName: t.name,
          counts: { total: live(t.id).length, ...counts(t.id) },
        },
      }
    },
    push_item: (a) => ({
      data: view(push(tube(a.tubeId).id, a.payload)),
      created: true,
    }),
    bulk_push_items: (a) => {
      const t = tube(a.tubeId)
      const list = a.items as { payload: unknown }[]
      if (list.length > 500) throw invalid("At most 500 items")
      const results = list.map((entry, index) => {
        try {
          return {
            index,
            ok: true,
            created: true,
            data: view(push(t.id, entry.payload)),
          }
        } catch (err) {
          return {
            index,
            ok: false,
            error: {
              code: "validation_error",
              message: (err as Error).message,
            },
          }
        }
      })
      return { results }
    },
    get_item: (a) => ({ data: view(item(a.id)) }),
    update_item: (a) => {
      const i = item(a.id)
      if (i.deletedAt) throw notFound("Item", i.id)
      applyPatch(i, a)
      return { data: view(i) }
    },
    delete_item: (a) => {
      const i = item(a.id)
      i.deletedAt = now()
      i.leased = false
      return { deleted: true, id: i.id }
    },
    list_items: (a) => {
      const t = tube(a.tubeId)
      const statuses = statusList(a.status)
      let list = live(t.id).filter(
        (i) => !statuses || statuses.includes(i.status)
      )
      if (a.countOnly) return { total: list.length }
      if (a.order === "desc") list = list.reverse()
      const offset = Number(a.offset ?? 0)
      const limit = Number(a.limit ?? 100)
      const page = list.slice(offset, offset + limit)
      const fields = a.fields as string[] | undefined
      return {
        data: page.map((i) =>
          fields
            ? Object.fromEntries(
                fields.map((f) => [f, (i as Record<string, unknown>)[f]])
              )
            : view(i)
        ),
        page: { offset, limit, total: list.length },
      }
    },
    bulk_update_items: (a) => {
      if (!a.tubeId) throw invalid("fake supports the filter form only")
      const t = tube(a.tubeId)
      const statuses = statusList((a.filter as { status?: unknown })?.status)
      const matched = live(t.id).filter(
        (i) => !statuses || statuses.includes(i.status)
      )
      for (const i of matched) applyPatch(i, a.patch as Record<string, unknown>)
      return { affected: matched.length }
    },
    bulk_delete_items: (a) => {
      const t = tube(a.tubeId)
      const statuses = statusList(a.status)
      const matched = live(t.id).filter(
        (i) => !statuses || statuses.includes(i.status)
      )
      for (const i of matched) {
        i.deletedAt = now()
        i.leased = false
      }
      return { deleted: matched.length }
    },
    claim_next_item: (a, agent) => {
      const t = tube(a.tubeId)
      const next = live(t.id)
        .filter((i) => i.status === "pending")
        .sort((x, y) => y.priority - x.priority || x.seq - y.seq)[0]
      if (!next)
        return { claimed: false, data: null, message: "Nothing to claim" }
      const at = now()
      next.status = "processing"
      next.assignedAgent = agent
      next.leased = true
      next.leaseExpiresAt = null
      next.attempts++
      next.updatedAt = at
      return {
        claimed: true,
        data: view(next),
        claim: {
          itemId: next.id,
          agentId: agent,
          claimedAt: at,
          leaseExpiresAt: null,
          attempts: next.attempts,
        },
      }
    },
    complete_item: (a, agent) => {
      const i = item(a.id)
      holder(i, agent)
      i.status = "completed"
      i.leased = false
      if ("result" in a) i.result = a.result
      i.updatedAt = now()
      return { data: view(i) }
    },
    fail_item: (a, agent) => {
      const i = item(a.id)
      holder(i, agent)
      const t = tubes.get(i.tubeId)
      i.status = i.attempts < (t?.maxAttempts ?? 3) ? "retry" : "failed"
      i.leased = false
      const err = a.error as string | { message: string }
      i.lastError = { message: typeof err === "string" ? err : err.message }
      if ("result" in a) i.result = a.result
      i.updatedAt = now()
      return { data: view(i) }
    },
    release_item: (a, agent) => {
      const i = item(a.id)
      holder(i, agent)
      i.status = "pending"
      i.leased = false
      i.assignedAgent = null
      i.updatedAt = now()
      return { data: view(i) }
    },
  }

  const call = (
    name: string,
    args: Record<string, unknown>,
    agent = "other-agent"
  ) => {
    const tool = tools[name]
    if (!tool) throw new ToolError("validation_error", `Unknown tool ${name}`)
    return tool(args, agent)
  }

  const readResource = (uri: string) => {
    if (uri === "mcpocket://system/info")
      return {
        data: {
          server: { name: "mcpocket-fake", version: "0" },
          you: {
            id: "mobilerun",
            workspace: "test",
            access: { role: "operator", scope: null },
          },
          tools: Object.keys(tools),
        },
      }
    const m = /^mcpocket:\/\/tubes\/(.+)$/.exec(uri)
    if (m) {
      const t = tube(m[1])
      return { data: { ...tubeView(t), itemCount: live(t.id).length } }
    }
    throw notFound("Resource", uri)
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`)
      return send(401, { error: "unauthorized" })
    const agent = String(req.headers["x-agent-id"] ?? "anonymous")
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const reply = (result: unknown) =>
      send(200, { jsonrpc: "2.0", id: rpc.id, result })
    try {
      if (rpc.method === "resources/read") {
        const data = readResource(rpc.params.uri)
        return reply({
          contents: [
            {
              uri: rpc.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(data),
            },
          ],
        })
      }
      if (rpc.method === "tools/call") {
        calls.push(rpc.params.name)
        const out = call(rpc.params.name, rpc.params.arguments ?? {}, agent)
        return reply({
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        })
      }
      return send(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      })
    } catch (err) {
      const e =
        err instanceof ToolError
          ? {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
            }
          : { code: "internal_error", message: String(err) }
      if (rpc.method === "resources/read")
        return send(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32002, message: e.message, data: { error: e } },
        })
      const body = { error: e }
      return reply({
        content: [{ type: "text", text: JSON.stringify(body) }],
        structuredContent: body,
        isError: true,
      })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api/mcp`,
    apiKey,
    tubes,
    items,
    calls,
    call,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** The fake mcpocket the shared test setup started for this test file. */
export function fakeMcpocket(): FakeMcpocket {
  const fake = (globalThis as { __fakeMcpocket?: FakeMcpocket }).__fakeMcpocket
  if (!fake) throw new Error("fake mcpocket not started (tests/setup.ts)")
  return fake
}
