# mcpocket changes needed for the mobilerun integration

mobilerun will use mcpocket tubes as its job queue. Tubes are what mobilerun calls "channels", and items are its "records". One fixed agent ID per install claims items for device runs. External workers keep using mobilerun's old HTTP routes, which forward to mcpocket. mobilerun connects with an `operator` key and shows every tube that key can see.

## Required

### 1. Leases that never expire

Workers that come through the forwarding routes never send heartbeats, and a device run can take longer than any fixed lease. The old system had no lease timeouts.

- Accept `leaseSeconds: 0` on `claim_next_item`, `create_tube` and `update_tube`. It means **the lease never expires**.
- An item claimed this way stays `processing` until `complete_item`, `fail_item`, `release_item` or a manual status change. `claim_next_item` must never reclaim it.
- In the response, `claim.leaseExpiresAt` is `null`.
- Say this in the tool descriptions.

### 2. Manual status transitions (`update_item`, `bulk_update_items`)

Define and document what an operator can set, and from which status:

| Target | Allowed from | Side effects |
| --- | --- | --- |
| `pending` | any | clear the lease, `assignedAgent` and `retryAt`; **keep `createdAt`**, so the item keeps its place in the queue |
| `completed`, `failed`, `cancelled`, `archived` | any | clear the lease; keep `assignedAgent` for history |
| `processing` | — | reject with `validation_error` (only `claim_next_item` starts processing) |

**After a manual change, the old lease holder can no longer act on the item.** `complete_item`, `fail_item`, `release_item` and `heartbeat_item` from that agent must answer `conflict` and change nothing. mobilerun relies on this so that a finishing run never overwrites a status the operator set by hand.

### 3. `result` in `update_item` and `bulk_update_items`

- Add an optional `result` field (any JSON; `null` clears it), in both the per-item form and the `patch` form.
- No lease is needed. Record it as an `updated` history event with the old and new values.

mobilerun needs this because a worker's `set` sends a status plus a result, and the worker may not hold a lease.

### 4. `bulk_delete_items` (new tool)

- Two forms: `{ ids: uuid[] }` (at most 1000), or `{ tubeId, status?: string | string[] }`. The filter form deletes every match on the server, with no cap.
- Same soft delete and `deleted` history event as `delete_item`. If an item is `processing`, delete it anyway and drop its lease.
- Returns `{ deleted: number }`. The ids form also returns per-item `results`, like `bulk_update_items`.
- Roles: operator and admin.

### 5. `delete_tube { id, force?: boolean }`

- With `force: true`, soft-delete every item and then the tube, in one atomic write.
- Returns `{ deleted: true, id, deletedItems }`.
- Without `force`, it keeps working as it does now.

## Nice to have

6. **Bulk update by filter:** `bulk_update_items { tubeId, filter: { status }, patch }`, done on the server with no 500 cap. Returns `{ affected }`. Used for "reset all processing → pending".
7. **Counts in `list_tubes`:** `list_tubes { withCounts: true }` adds `counts: { pending, processing, completed, failed, retry, cancelled, archived }` to each tube. This replaces one `get_tube_statistics` call per tube.
8. **Exact-name filter:** `list_tubes { name }` matches a name exactly. The forwarding routes need it to accept a tube name in the URL as well as a UUID.
9. **`result` on `fail_item`:** an optional `result` stored like `complete_item`'s, next to `error`.

## Acceptance checks

Run in a temporary tube, then delete it:

- Claim with `leaseSeconds: 0` → `leaseExpiresAt` is `null`, and a second claim returns `claimed: false`.
- Claim, then `update_item` to `pending` → `complete_item` from the claiming agent returns `conflict`, and the item is claimable again, still first in line.
- `update_item { status: "completed", result: {...} }` → the result is saved.
- `update_item { status: "processing" }` → `validation_error`.
- `bulk_delete_items { tubeId, status: "completed" }` → only completed items are gone.
- `delete_tube { force: true }` on a tube that still has items → it's deleted.
- If implemented: the filter form of `bulk_update_items`, `list_tubes { withCounts, name }`, and `fail_item { result }`.
