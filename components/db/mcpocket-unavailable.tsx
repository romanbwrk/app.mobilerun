import Link from "next/link"

import { ApiError } from "@/lib/api/errors"

/** True for failures that mean "mcpocket is not set up or not answering", not a bad request. */
export function isMcpocketUnavailable(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    (err.code === "mcpocket_not_configured" ||
      err.code === "mcpocket_error" ||
      err.code === "rate_limited")
  )
}

/** Shown in place of the Database pages while mcpocket cannot be reached. */
export function McpocketUnavailable({ error }: { error: ApiError }) {
  return (
    <div className="grid max-w-xl gap-2 border border-dashed p-4 text-sm">
      <p className="font-medium">
        {error.code === "mcpocket_not_configured"
          ? "mcpocket is not configured"
          : "mcpocket is not reachable"}
      </p>
      <p className="text-muted-foreground">{error.message}</p>
      <p>
        <Link href="/settings" className="underline">
          Open Settings
        </Link>{" "}
        to add or check the operator API key.
      </p>
    </div>
  )
}
