"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch, apiJson } from "@/lib/client/api"
import type { McpocketStatus } from "@/lib/mcpocket/status"
import type { McpocketSettingsView } from "@/lib/settings"

/**
 * The mcpocket connection behind the Database section: operator API key,
 * endpoint and agent id, with a live connection check. The key is write-only:
 * the page only ever shows its last four characters.
 */
export function McpocketForm({
  mcpocket,
  initialStatus,
}: {
  mcpocket: McpocketSettingsView
  /** Connection check done while the page rendered; null without a key. */
  initialStatus: McpocketStatus | null
}) {
  const router = useRouter()
  const [apiKey, setApiKey] = useState("")
  const [url, setUrl] = useState(mcpocket.saved.url)
  const [agentId, setAgentId] = useState(mcpocket.saved.agentId)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{
    kind: "ok" | "error"
    text: string
  } | null>(null)
  const [check, setCheck] = useState<McpocketStatus | null>(initialStatus)
  const [checking, setChecking] = useState(false)

  async function runCheck() {
    setChecking(true)
    const res = await apiFetch<{ status: McpocketStatus }>(
      "/api/settings/mcpocket"
    )
    setChecking(false)
    setCheck(
      res.ok
        ? res.body.status
        : { ok: false, code: res.code ?? "error", message: res.message }
    )
  }

  async function save(payload: Record<string, string>, done: string) {
    setSaving(true)
    setMessage(null)
    const res = await apiJson("/api/settings", "PATCH", payload)
    setSaving(false)
    if (!res.ok) return setMessage({ kind: "error", text: res.message })
    setApiKey("")
    setMessage({ kind: "ok", text: done })
    setCheck(null)
    router.refresh()
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const payload: Record<string, string> = {
      mcpocketUrl: url.trim(),
      mcpocketAgentId: agentId.trim(),
    }
    if (apiKey.trim()) payload.mcpocketApiKey = apiKey.trim()
    void save(payload, "Saved")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>mcpocket</CardTitle>
        <CardDescription>
          The Database section stores its channels and records in mcpocket. Use
          an API key with the operator role; every tube the key can see shows up
          as a channel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-md gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="mcpocket-key">Operator API key</Label>
            <Input
              id="mcpocket-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                mcpocket.apiKeySet
                  ? `•••• ${mcpocket.apiKeyHint ?? ""} (leave empty to keep)`
                  : "mcp_..."
              }
            />
            <p className="text-xs text-muted-foreground">
              {mcpocket.keySource === "env"
                ? "Currently taken from MCPOCKET_API_KEY. A key saved here takes precedence."
                : mcpocket.keySource === "settings"
                  ? "Saved here. It never leaves the server."
                  : "No key yet: the Database section and channel-bound tasks are unavailable until you add one."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcpocket-url">Endpoint</Label>
            <Input
              id="mcpocket-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={mcpocket.url}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for the default ({mcpocket.url}).
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcpocket-agent">Agent id</Label>
            <Input
              id="mcpocket-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder={mcpocket.agentId}
            />
            <p className="text-xs text-muted-foreground">
              The identity this install claims records as. Changing it while
              runs hold records stops those runs from settling them.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              Save
            </Button>
            {mcpocket.keySource === "settings" ? (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() =>
                  save({ mcpocketApiKey: "" }, "Saved key removed")
                }
              >
                Remove saved key
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={checking || !mcpocket.apiKeySet}
              onClick={runCheck}
            >
              {checking ? "Checking…" : "Test connection"}
            </Button>
            {message ? (
              <span
                className={
                  message.kind === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {message.text}
              </span>
            ) : null}
          </div>
          {check ? <CheckResult status={check} /> : null}
        </form>
      </CardContent>
    </Card>
  )
}

function CheckResult({ status }: { status: McpocketStatus }) {
  if (!status.ok)
    return <p className="text-sm text-destructive">{status.message}</p>
  const problems = [
    status.role !== "operator" && status.role !== "admin"
      ? `the key's role is "${status.role ?? "unknown"}", not operator`
      : null,
    status.missingTools.length > 0
      ? `missing tools: ${status.missingTools.join(", ")}`
      : null,
  ].filter(Boolean)
  return (
    <div className="grid gap-1 text-xs">
      <p className={problems.length ? "text-destructive" : "text-foreground"}>
        {problems.length
          ? `Connected, but ${problems.join("; ")}.`
          : "Connected."}
      </p>
      <p className="text-muted-foreground">
        {status.server} · workspace {status.workspace ?? "—"} · role{" "}
        {status.role ?? "—"}
        {status.scoped ? " (scoped)" : ""} · agent {status.agentId ?? "—"}
      </p>
    </div>
  )
}
