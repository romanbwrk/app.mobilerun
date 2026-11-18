/** The parts of mcpocket's objects this app reads. */

export type McpocketStatusCounts = {
  pending: number
  processing: number
  completed: number
  failed: number
  retry: number
  cancelled: number
  archived: number
}

export type McpocketTube = {
  id: string
  folderId: string | null
  name: string
  description?: string | null
  enabled: boolean
  leaseSeconds?: number | null
  counts?: McpocketStatusCounts
  createdAt: string
  updatedAt: string
}

export type McpocketFolderNode = {
  id: string
  parentId: string | null
  name: string
  children: McpocketFolderNode[]
  tubes: McpocketTube[]
}

export type McpocketItem = {
  id: string
  tubeId: string
  status: string
  payload: Record<string, unknown>
  result?: unknown
  lastError?: { message?: string } | null
  assignedAgent: string | null
  leaseExpiresAt: string | null
  attempts: number
  deletedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type McpocketPage<T> = {
  data: T[]
  page: { offset: number; limit: number; total: number }
}

export type McpocketClaim = {
  claimed: boolean
  data: McpocketItem | null
  claim?: { itemId: string; agentId: string; claimedAt: string }
}

export type McpocketBulkResult = {
  index: number
  ok: boolean
  data?: McpocketItem
  error?: { code?: string; message?: string }
}
