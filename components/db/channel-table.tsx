import Link from "next/link"

import { LocalTime } from "@/components/app/local-time"
import { ChannelActions } from "@/components/db/channel-actions"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ChannelView } from "@/lib/db-channels"

const COLUMNS = ["pending", "processing", "completed", "failed"] as const

const Count = ({ n }: { n: number }) =>
  n > 0 ? <>{n}</> : <span className="text-muted-foreground">0</span>

export function ChannelTable({ channels }: { channels: ChannelView[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Folder</TableHead>
          {COLUMNS.map((s) => (
            <TableHead key={s} className="text-right capitalize">
              {s}
            </TableHead>
          ))}
          <TableHead
            className="text-right"
            title="retry, cancelled and archived"
          >
            Other
          </TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.map((c) => (
          <TableRow key={c.id}>
            <TableCell>
              <Link
                href={`/db/${c.id}`}
                className="font-mono font-medium hover:underline"
              >
                {c.name}
              </Link>
              {c.description ? (
                <p className="max-w-md truncate text-xs text-muted-foreground">
                  {c.description}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {c.folder ?? "—"}
            </TableCell>
            {COLUMNS.map((s) => (
              <TableCell key={s} className="text-right tabular-nums">
                <Count n={c.counts[s]} />
              </TableCell>
            ))}
            <TableCell className="text-right tabular-nums">
              <Count
                n={c.counts.retry + c.counts.cancelled + c.counts.archived}
              />
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              <LocalTime value={c.createdAt} />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end">
                <ChannelActions channel={c} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
