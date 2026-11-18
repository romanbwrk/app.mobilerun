import { z } from "zod"

import { ApiError, conflict, notFound } from "@/lib/api/errors"
import {
  DB_RECORD_STATUSES,
  normalizeRecordStatus,
  SETTABLE_RECORD_STATUSES,
  type DbRecordStatus,
} from "@/lib/db-record-status"
import { callTool, readResource } from "@/lib/mcpocket/client"
import type {
  McpocketBulkResult,
  McpocketClaim,
  McpocketFolderNode,
  McpocketItem,
  McpocketPage,
  McpocketStatusCounts,
  McpocketTube,
} from "@/lib/mcpocket/types"

/**
 * Channels and records, stored in mcpocket: a channel is a tube, a record is
 * an item. Every function takes a channel reference that is either the tube's
 * id or its exact name, so the worker API keeps working with the names that
 * used to be slugs.
 */

export { DB_RECORD_STATUSES, type DbRecordStatus }

/** Most objects one `add` call may carry. */
export const MAX_ADD_BATCH = 10_000
/** mcpocket's per-call cap for bulk_push_items. */
const PUSH_CHUNK = 500
/** mcpocket's page cap for list calls. */
const LIST_PAGE = 1000

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v: string) => UUID_RE.test(v)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Names used to be slugs in the API path; any name works now, but these still clash. */
const RESERVED_NAMES = ["channels"]

export const channelNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(200)
  .refine((v) => !RESERVED_NAMES.includes(v), {
    message: "This name is reserved",
  })
  .refine((v) => !isUuid(v), { message: "A name cannot look like an id" })
  .refine((v) => !v.includes("/"), { message: "A name cannot contain /" })

const descriptionSchema = z.string().trim().max(2000)

export const createChannelSchema = z.object({
  name: channelNameSchema,
  description: descriptionSchema.default(""),
})

export const updateChannelSchema = z
  .object({ name: channelNameSchema, description: descriptionSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields provided" })

/** A JSON object; arrays and primitives are rejected. Unknown keys are kept. */
const plainObject = z.looseObject({})

export const addRecordsSchema = z.union([
  plainObject,
  z
    .array(plainObject)
    .max(MAX_ADD_BATCH, `At most ${MAX_ADD_BATCH} records per call`),
])

export const recordStatusSchema = z.preprocess(
  normalizeRecordStatus,
  z.enum(DB_RECORD_STATUSES)
)

/** Status a caller may set by hand: anything but processing (only a claim starts it). */
const settableStatusSchema = z.preprocess(
  normalizeRecordStatus,
  z.enum(SETTABLE_RECORD_STATUSES as [string, ...string[]], {
    message: `Status must be one of ${SETTABLE_RECORD_STATUSES.join(", ")}`,
  })
)

/** Worker `set`: status and/or result, at least one. `result` replaces the previous one wholesale. */
export const setRecordSchema = z
  .object({
    status: settableStatusSchema,
    result: plainObject.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide status and/or result",
  })

/** Operator edit: data and/or status, at least one. */
export const updateRecordSchema = z
  .object({
    data: plainObject,
    status: settableStatusSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide data and/or status",
  })

export const listRecordsSchema = z.object({
  status: recordStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

export const bulkRecordsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset_processing") }),
  z.object({
    action: z.literal("delete_by_status"),
    status: recordStatusSchema,
  }),
  z.object({ action: z.literal("clear") }),
])

export type BulkRecordsInput = z.infer<typeof bulkRecordsSchema>

/** Export query: optionally one status. The output is the import format. */
export const exportRecordsSchema = z.object({
  status: recordStatusSchema.optional(),
})

export type ExportRecordsQuery = z.infer<typeof exportRecordsSchema>

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type StatusCounts = Record<DbRecordStatus, number>

export type ChannelView = {
  /** The mcpocket tube id; used in UI URLs and stored on tasks. */
  id: string
  name: string
  description: string
  /** Folder path in mcpocket ("Parent / Child"), or null for a top-level tube. */
  folder: string | null
  counts: StatusCounts
  /** Sum of all counts. */
  total: number
  createdAt: string
  updatedAt: string
}

export type RecordView = {
  id: string
  /** Tube id of the owning channel. */
  channel: string
  status: DbRecordStatus
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  /** Message of the last failure, if any. */
  error: string | null
  /** The mcpocket agent holding or last holding the record. */
  agent: string | null
  attempts: number
  /** Only known on the response of the claim that handed the record out. */
  claimedAt: string | null
  createdAt: string
  updatedAt: string
}

export type RecordPage = {
  records: RecordView[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export const emptyCounts = (): StatusCounts => ({
  pending: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  retry: 0,
  cancelled: 0,
  archived: 0,
})

const sumCounts = (c: StatusCounts) =>
  DB_RECORD_STATUSES.reduce((n, s) => n + c[s], 0)

function toCounts(
  raw: Partial<McpocketStatusCounts> | undefined
): StatusCounts {
  const counts = emptyCounts()
  for (const s of DB_RECORD_STATUSES) counts[s] = Number(raw?.[s] ?? 0)
  return counts
}

function toChannelView(
  tube: McpocketTube,
  counts: StatusCounts,
  folder: string | null
): ChannelView {
  return {
    id: tube.id,
    name: tube.name,
    description: tube.description ?? "",
    folder,
    counts,
    total: sumCounts(counts),
    createdAt: tube.createdAt,
    updatedAt: tube.updatedAt,
  }
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null

export function toRecordView(
  item: McpocketItem,
  claimedAt: string | null = null
): RecordView {
  const status = (DB_RECORD_STATUSES as readonly string[]).includes(item.status)
    ? (item.status as DbRecordStatus)
    : "pending"
  return {
    id: item.id,
    channel: item.tubeId,
    status,
    data: asObject(item.payload) ?? {},
    result: asObject(item.result),
    error: item.lastError?.message ?? null,
    agent: item.assignedAgent ?? null,
    attempts: item.attempts ?? 0,
    claimedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Turns a channel reference (tube id or exact tube name) into a tube id.
 * A name shared by several tubes is refused rather than guessed.
 */
export async function resolveChannelId(ref: string): Promise<string> {
  const value = ref.trim()
  if (!value) throw notFound("Channel")
  if (isUuid(value)) return value
  const res = await callTool<McpocketPage<McpocketTube>>("list_tubes", {
    name: value,
    limit: 2,
  })
  if (res.data.length === 0) throw notFound("Channel")
  if (res.data.length > 1)
    throw conflict(
      `Several channels are named "${value}"; use the channel id instead`
    )
  return res.data[0].id
}

/** Folder id → "Parent / Child" for every folder the key can see. */
async function folderPaths(): Promise<Map<string, string>> {
  const tree = await callTool<{ data: McpocketFolderNode[] }>("get_folder_tree")
  const paths = new Map<string, string>()
  const walk = (nodes: McpocketFolderNode[], prefix: string) => {
    for (const n of nodes) {
      const path = prefix ? `${prefix} / ${n.name}` : n.name
      paths.set(n.id, path)
      walk(n.children ?? [], path)
    }
  }
  walk(tree.data ?? [], "")
  return paths
}

/** Every tube the API key can see, with counts, sorted by folder then name. */
export async function listChannels(): Promise<ChannelView[]> {
  const tubes: McpocketTube[] = []
  const [paths] = await Promise.all([
    folderPaths(),
    (async () => {
      for (let offset = 0; ; offset += LIST_PAGE) {
        const res = await callTool<McpocketPage<McpocketTube>>("list_tubes", {
          withCounts: true,
          offset,
          limit: LIST_PAGE,
        })
        tubes.push(...res.data)
        if (res.data.length < LIST_PAGE) break
      }
    })(),
  ])
  return tubes
    .map((t) =>
      toChannelView(
        t,
        toCounts(t.counts),
        t.folderId ? (paths.get(t.folderId) ?? null) : null
      )
    )
    .sort(
      (a, b) =>
        (a.folder ?? "").localeCompare(b.folder ?? "") ||
        a.name.localeCompare(b.name)
    )
}

async function readTube(id: string): Promise<McpocketTube> {
  const res = await readResource<{ data: McpocketTube }>(
    `mcpocket://tubes/${id}`
  )
  return res.data
}

async function tubeCounts(id: string): Promise<StatusCounts> {
  const res = await callTool<{ data: { counts: McpocketStatusCounts } }>(
    "get_tube_statistics",
    { id }
  )
  return toCounts(res.data.counts)
}

export async function getChannel(ref: string): Promise<ChannelView> {
  const id = await resolveChannelId(ref)
  const [tube, counts] = await Promise.all([readTube(id), tubeCounts(id)])
  let folder: string | null = null
  if (tube.folderId) folder = (await folderPaths()).get(tube.folderId) ?? null
  return toChannelView(tube, counts, folder)
}

/** Id and current name of a channel; throws the channel 404 when it is gone. */
export async function channelRef(
  ref: string
): Promise<{ id: string; name: string }> {
  const id = await resolveChannelId(ref)
  const tube = await readTube(id)
  return { id: tube.id, name: tube.name }
}

/** Throws the channel 404 unless the reference names a tube; returns its id. */
export async function ensureChannel(ref: string): Promise<string> {
  return (await channelRef(ref)).id
}

/** Names double as API path segments, so a second tube with the same name is refused. */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const res = await callTool<McpocketPage<McpocketTube>>("list_tubes", {
    name,
    limit: 2,
  })
  if (res.data.some((t) => t.id !== exceptId))
    throw conflict(`Channel "${name}" already exists`)
}

export async function createChannel(input: unknown): Promise<ChannelView> {
  const data = createChannelSchema.parse(input)
  await assertNameFree(data.name)
  // Leases never expire (runs and workers hold a record for as long as they
  // need it) and a failure is final, as it was before mcpocket.
  const res = await callTool<{ data: McpocketTube }>("create_tube", {
    name: data.name,
    ...(data.description ? { description: data.description } : {}),
    leaseSeconds: 0,
    retryPolicy: { maxAttempts: 1 },
  })
  return toChannelView(res.data, emptyCounts(), null)
}

export async function updateChannel(
  ref: string,
  input: unknown
): Promise<ChannelView> {
  const data = updateChannelSchema.parse(input)
  const id = await resolveChannelId(ref)
  if (data.name) await assertNameFree(data.name, id)
  const args: Record<string, unknown> = { id }
  if (data.name !== undefined) args.name = data.name
  if (data.description !== undefined)
    args.description = data.description || null
  await callTool("update_tube", args)
  return getChannel(id)
}

/** Deletes a channel together with every record it holds. */
export async function deleteChannel(
  ref: string
): Promise<{ deletedRecords: number }> {
  const id = await resolveChannelId(ref)
  const res = await callTool<{ deletedItems?: number }>("delete_tube", {
    id,
    force: true,
  })
  return { deletedRecords: res.deletedItems ?? 0 }
}

// ---------------------------------------------------------------------------
// Records: the single insertion path shared by workers and the UI import
// ---------------------------------------------------------------------------

/**
 * Pushes objects as pending records, in input order (FIFO). mcpocket accepts
 * 500 per call, so a large batch goes in several writes: a record rejected by
 * the tube's schema does not stop the others, and the call then fails with a
 * message saying how many were stored.
 */
export async function addRecords(
  ref: string,
  input: unknown
): Promise<RecordView[]> {
  const parsed = addRecordsSchema.parse(input)
  const objects = Array.isArray(parsed) ? parsed : [parsed]
  const tubeId = await resolveChannelId(ref)
  if (objects.length === 0) {
    await readTube(tubeId)
    return []
  }
  const added: RecordView[] = []
  const rejected: string[] = []
  for (let start = 0; start < objects.length; start += PUSH_CHUNK) {
    const chunk = objects.slice(start, start + PUSH_CHUNK)
    const res = await callTool<{ results: McpocketBulkResult[] }>(
      "bulk_push_items",
      { tubeId, items: chunk.map((payload) => ({ payload })) }
    )
    for (const r of res.results) {
      if (r.ok && r.data) added.push(toRecordView(r.data))
      else
        rejected.push(`#${start + r.index}: ${r.error?.message ?? "rejected"}`)
    }
  }
  if (rejected.length > 0)
    throw new ApiError(
      "validation_error",
      `${rejected.length} of ${objects.length} records were rejected and ${added.length} were added. First: ${rejected[0]}`,
      400
    )
  return added
}

// ---------------------------------------------------------------------------
// Worker operations
// ---------------------------------------------------------------------------

/**
 * Atomically claims the next record (mcpocket order: highest priority, then
 * oldest) with a lease that never expires, so two workers or runs never
 * receive the same record and a slow one never loses it.
 */
export async function claimNextRecord(ref: string): Promise<RecordView | null> {
  const tubeId = await resolveChannelId(ref)
  const res = await callTool<McpocketClaim>("claim_next_item", {
    tubeId,
    leaseSeconds: 0,
  })
  if (!res.claimed || !res.data) return null
  return toRecordView(res.data, res.claim?.claimedAt ?? null)
}

/** The pending record the next claim would most likely hand out, without claiming it. */
export async function peekNextRecord(ref: string): Promise<RecordView | null> {
  const tubeId = await resolveChannelId(ref)
  const res = await callTool<McpocketPage<McpocketItem>>("list_items", {
    tubeId,
    status: "pending",
    order: "asc",
    limit: 1,
  })
  return res.data[0] ? toRecordView(res.data[0]) : null
}

export type ChannelOption = {
  id: string
  name: string
  folder: string | null
  /** The record the next run of a task bound to this channel would claim. */
  nextRecord: { id: string; data: Record<string, unknown> } | null
}

/**
 * Every channel with its next pending record, for the task form's channel
 * picker. When mcpocket is unreachable or not configured the list is empty
 * and `error` says why, so the task form still renders.
 */
export async function listChannelOptions(): Promise<{
  channels: ChannelOption[]
  error: string | null
}> {
  try {
    const channels = await listChannels()
    const options = await Promise.all(
      channels.map(async (c) => {
        const next = c.counts.pending > 0 ? await peekNextRecord(c.id) : null
        return {
          id: c.id,
          name: c.name,
          folder: c.folder,
          nextRecord: next ? { id: next.id, data: next.data } : null,
        }
      })
    )
    return { channels: options, error: null }
  } catch (err) {
    return {
      channels: [],
      error: err instanceof Error ? err.message : "mcpocket unavailable",
    }
  }
}

/**
 * Cheap check used by the queue dispatcher before it commits a device to a
 * channel task. Counts only `pending`: a `retry` record may still be waiting
 * out its backoff, and a dispatch that then claims nothing records a skip.
 */
export async function hasPendingRecord(ref: string): Promise<boolean> {
  const tubeId = await resolveChannelId(ref)
  const res = await callTool<{ total: number }>("list_items", {
    tubeId,
    status: "pending",
    countOnly: true,
  })
  return res.total > 0
}

export type SettleRecordOutcome =
  | { status: "completed" | "failed"; result: Record<string, unknown> }
  | { status: "pending" }

/**
 * Settles a record this install claimed: completed or failed with a result,
 * or released back to pending at its original queue position. mcpocket only
 * accepts this from the lease holder while the record is still processing,
 * so a record an operator already changed by hand answers `conflict` and is
 * left alone. Returns whether the record was changed.
 */
export async function settleRecord(
  id: string,
  outcome: SettleRecordOutcome
): Promise<boolean> {
  try {
    if (outcome.status === "completed")
      await callTool("complete_item", { id, result: outcome.result })
    else if (outcome.status === "failed")
      await callTool("fail_item", {
        id,
        error: {
          message: String(outcome.result.reason || "Run failed").slice(
            0,
            10_000
          ),
        },
        result: outcome.result,
      })
    else
      await callTool("release_item", { id, reason: "Run did not process it" })
    return true
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.code === "conflict" || err.code === "not_found")
    )
      return false
    throw err
  }
}

/** Finds a live record inside its channel, or throws the record 404. */
async function findRecord(tubeId: string, id: string): Promise<McpocketItem> {
  if (!isUuid(id)) throw notFound("Record")
  const res = await callTool<{ data: McpocketItem }>("get_item", { id })
  if (res.data.tubeId !== tubeId || res.data.deletedAt) throw notFound("Record")
  return res.data
}

/** Worker `set`: status and/or result, no lease needed. */
export async function setRecord(
  ref: string,
  id: string,
  input: unknown
): Promise<RecordView> {
  const data = setRecordSchema.parse(input)
  const tubeId = await resolveChannelId(ref)
  await findRecord(tubeId, id)
  const args: Record<string, unknown> = { id }
  if (data.status !== undefined) args.status = data.status
  if ("result" in data) args.result = data.result ?? null
  const res = await callTool<{ data: McpocketItem }>("update_item", args)
  return toRecordView(res.data)
}

/** Returns a processing record to pending at its original queue position. */
export async function undoRecord(ref: string, id: string): Promise<RecordView> {
  const tubeId = await resolveChannelId(ref)
  const current = await findRecord(tubeId, id)
  if (current.status !== "processing")
    throw conflict(
      `Record is ${current.status}; only processing records can be undone`
    )
  try {
    const res = await callTool<{ data: McpocketItem }>("release_item", { id })
    return toRecordView(res.data)
  } catch (err) {
    // Claimed by another mcpocket agent: release it as an operator instead.
    if (!(err instanceof ApiError) || err.code !== "conflict") throw err
    const res = await callTool<{ data: McpocketItem }>("update_item", {
      id,
      status: "pending",
    })
    return toRecordView(res.data)
  }
}

// ---------------------------------------------------------------------------
// Operator operations
// ---------------------------------------------------------------------------

/** Newest first, page-based. */
export async function listRecords(
  ref: string,
  query: unknown
): Promise<RecordPage> {
  const q = listRecordsSchema.parse(query)
  const tubeId = await resolveChannelId(ref)
  const res = await callTool<McpocketPage<McpocketItem>>("list_items", {
    tubeId,
    order: "desc",
    offset: (q.page - 1) * q.pageSize,
    limit: q.pageSize,
    ...(q.status ? { status: q.status } : {}),
  })
  const total = res.page.total
  return {
    records: res.data.map((i) => toRecordView(i)),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  }
}

/**
 * Each record's `data` object, oldest first, as an async iterable fetched a
 * page at a time so a large channel never sits in memory at once. The output
 * is exactly what `addRecords` accepts. The first page is fetched before
 * returning, so an unknown channel surfaces as a 404 and not as a broken download.
 */
export async function exportRecords(
  ref: string,
  query: unknown
): Promise<{
  query: ExportRecordsQuery
  name: string
  objects: AsyncIterable<Record<string, unknown>>
}> {
  const q = exportRecordsSchema.parse(query)
  const tubeId = await resolveChannelId(ref)
  const tube = await readTube(tubeId)
  const page = (offset: number) =>
    callTool<McpocketPage<{ payload?: Record<string, unknown> }>>(
      "list_items",
      {
        tubeId,
        order: "asc",
        offset,
        limit: LIST_PAGE,
        fields: ["payload"],
        ...(q.status ? { status: q.status } : {}),
      }
    )
  const first = await page(0)
  async function* iterate(): AsyncIterable<Record<string, unknown>> {
    let current = first
    for (let offset = 0; ;) {
      for (const item of current.data) yield asObject(item.payload) ?? {}
      if (current.data.length < LIST_PAGE) return
      offset += LIST_PAGE
      current = await page(offset)
    }
  }
  return { query: q, name: tube.name, objects: iterate() }
}

export async function getRecord(ref: string, id: string): Promise<RecordView> {
  const tubeId = await resolveChannelId(ref)
  return toRecordView(await findRecord(tubeId, id))
}

/** Operator edit: replaces `data` wholesale and/or changes the status. */
export async function updateRecord(
  ref: string,
  id: string,
  input: unknown
): Promise<RecordView> {
  const data = updateRecordSchema.parse(input)
  const tubeId = await resolveChannelId(ref)
  await findRecord(tubeId, id)
  const args: Record<string, unknown> = { id }
  if (data.data !== undefined) args.payload = data.data
  if (data.status !== undefined) args.status = data.status
  const res = await callTool<{ data: McpocketItem }>("update_item", args)
  return toRecordView(res.data)
}

export async function deleteRecord(ref: string, id: string): Promise<void> {
  const tubeId = await resolveChannelId(ref)
  await findRecord(tubeId, id)
  await callTool("delete_item", { id })
}

/** Bulk operations scoped to one channel. Returns how many records were affected. */
export async function bulkRecords(
  ref: string,
  input: unknown
): Promise<{ affected: number }> {
  const op = bulkRecordsSchema.parse(input)
  const tubeId = await resolveChannelId(ref)
  switch (op.action) {
    case "reset_processing": {
      const res = await callTool<{ affected: number }>("bulk_update_items", {
        tubeId,
        filter: { status: "processing" },
        patch: { status: "pending" },
      })
      return { affected: res.affected ?? 0 }
    }
    case "delete_by_status": {
      const res = await callTool<{ deleted: number }>("bulk_delete_items", {
        tubeId,
        status: op.status,
      })
      return { affected: res.deleted ?? 0 }
    }
    case "clear": {
      const res = await callTool<{ deleted: number }>("bulk_delete_items", {
        tubeId,
      })
      return { affected: res.deleted ?? 0 }
    }
  }
}
