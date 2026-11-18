import { PageHeader } from "@/components/app/page-header"
import { ChannelTable } from "@/components/db/channel-table"
import {
  isMcpocketUnavailable,
  McpocketUnavailable,
} from "@/components/db/mcpocket-unavailable"
import { NewChannelButton } from "@/components/db/new-channel-button"
import { listChannels, type ChannelView } from "@/lib/db-channels"

export const dynamic = "force-dynamic"

export default async function DbPage() {
  let channels: ChannelView[]
  try {
    channels = await listChannels()
  } catch (err) {
    if (!isMcpocketUnavailable(err)) throw err
    return (
      <div>
        <PageHeader
          title="Database"
          description="Channels are mcpocket tubes: queues of JSON records that runs and external workers consume."
        />
        <McpocketUnavailable error={err} />
      </div>
    )
  }
  return (
    <div>
      <PageHeader
        title="Database"
        description="Channels are mcpocket tubes: queues of JSON records that runs and external workers consume."
        actions={<NewChannelButton />}
      />
      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No channels yet. Create one here or a tube in mcpocket; every tube
          your API key can see is listed.
        </p>
      ) : (
        <ChannelTable channels={channels} />
      )}
    </div>
  )
}
