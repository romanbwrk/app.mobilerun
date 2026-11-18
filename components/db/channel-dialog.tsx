"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { useDbApi } from "@/components/db/db-api-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ChannelView } from "@/lib/db-channels"

/** Creates a channel (an mcpocket tube), or renames / re-describes an existing one. */
export function ChannelDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel?: Pick<ChannelView, "id" | "name" | "description">
}) {
  const router = useRouter()
  const api = useDbApi()
  const [name, setName] = useState(channel?.name ?? "")
  const [description, setDescription] = useState(channel?.description ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    if (channel) {
      const res = await api.json(`/api/db/channels/${channel.id}`, "PATCH", {
        ...(name.trim() !== channel.name ? { name } : {}),
        description,
      })
      setBusy(false)
      if (!res.ok) return setError(res.message)
      onOpenChange(false)
      router.refresh()
      return
    }
    const res = await api.json<{ channel: { id: string } }>(
      "/api/db/channels",
      "POST",
      { name, description }
    )
    setBusy(false)
    if (!res.ok) return setError(res.message)
    onOpenChange(false)
    router.push(`/db/${res.body.channel.id}`)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {channel ? `Edit “${channel.name}”` : "New channel"}
            </DialogTitle>
            <DialogDescription>
              {channel
                ? "Workers that call the API by name need the new name after a rename; calls by id keep working."
                : "A channel is an mcpocket tube: a queue of JSON records that runs and external workers consume."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="leads"
              maxLength={200}
              autoFocus={!channel}
              required
            />
            <p className="text-xs text-muted-foreground">
              Unique; usable in the worker API path instead of the id.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="channel-description">Description</Label>
            <Textarea
              id="channel-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              placeholder="What the records in this channel are for"
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {channel ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
