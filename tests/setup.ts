import { randomUUID } from "node:crypto"
import mongoose from "mongoose"
import { afterAll, afterEach, beforeAll, inject } from "vitest"

import { startFakeMcpocket } from "./helpers/fake-mcpocket"

const baseUri = inject("mongoUri")
const dbName = `test_${randomUUID().slice(0, 8)}`
const uri = new URL(baseUri)
uri.pathname = `/${dbName}`

process.env.MONGODB_URI = uri.toString()
process.env.MONGODB_DB = dbName
process.env.EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN ?? "test-token"
process.env.EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://127.0.0.1:1"

// Every test file gets its own in-memory mcpocket, reached through the env
// fallback (nothing is saved on the Settings page in tests).
const mcpocket = await startFakeMcpocket()
;(globalThis as { __fakeMcpocket?: typeof mcpocket }).__fakeMcpocket = mcpocket
process.env.MCPOCKET_URL = mcpocket.url
process.env.MCPOCKET_API_KEY = mcpocket.apiKey
process.env.MCPOCKET_AGENT_ID = "mobilerun"

beforeAll(async () => {
  const { connectDb } = await import("@/lib/db")
  await connectDb(process.env.MONGODB_URI)
})

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return
  // One device runs one task at a time, so a run a test left queued or running
  // would make the shared device read as busy for every test after it.
  const { Run } = await import("@/lib/models/run")
  await Run.updateMany(
    { status: { $in: ["queued", "running"] } },
    { $set: { status: "cancelled", finishedAt: new Date() } }
  )
})

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db?.dropDatabase()
  }
  const { disconnectDb } = await import("@/lib/db")
  await disconnectDb()
  await mcpocket.close()
})
