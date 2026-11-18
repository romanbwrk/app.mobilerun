# mobilerun app

A control room for fleets of Android phones, built on top of [mobilerun](https://github.com/droidrun/mobilerun).

mobilerun is the core: its `MobileAgent` reads the screen and drives the phone over adb. Around it we built
everything you need to run phone automation as an ongoing operation rather than one-off CLI calls:

- **Web UI** — every connected phone with a live screenshot, task editor, live run view with the agent's steps
  and per-step screenshots, run history and export.
- **Databases ([mcpocket.io](https://app.mcpocket.io))** — queues of records (leads, URLs, accounts…) that tasks
  consume one per run, plus a small HTTP API for external workers.
- **Schedules** — timer-based (every N seconds) or queue-based (run next whenever the phone is free), with run
  limits, fail limits and one-task-per-device locking.
- **App cards** — per-app guidance the agent reads when it works in that app.
- **Jev mode** — an alternative engine ([TypeSafe Jev](https://docs.typesafe.ai)) that picks one checked action
  per step instead of free-form reasoning.
- **Task memory, variables and prompt overrides**, device profiles (Android users), battery/temperature guards.

## Architecture

```
 Browser ──► Next.js app (UI + API + Agenda jobs) ──► Executor (FastAPI + mobilerun) ──► adb ──► phones
                 │                      │
              MongoDB              mcpocket.io
 (devices, tasks, schedules,     (database channels
  runs, events, screenshots)       and records)
```

- **Next.js app** (this folder): the UI and the owner of all app data in MongoDB (devices, tasks, schedules,
  runs, run events, step screenshots, settings). Scheduling and run orchestration use
  [Agenda](https://github.com/hokify/agenda) inside the Next.js server process.
- **Executor** (`api/`): a small, stateless FastAPI service wrapping mobilerun's `MobileAgent` (and the Jev
  agent). It lists adb devices, takes screenshots, starts runs and streams their events over Server-Sent Events.
  It stores nothing. The mobilerun framework is vendored in `api/mobilerun` and installed from there.
- **mcpocket.io**: hosts the Database section. Channels are mcpocket *tubes*, records are *items*.

## Features

### Devices

Every phone `adb` sees, with a screenshot refreshed on an interval, a custom name, battery and temperature.
Runs are skipped while a phone is too hot or its battery too low (thresholds in Settings). Android user
profiles can be listed, created and switched per device.

### Tasks

A task is: a start (a URL opened through an adb intent, or an instruction), a goal, an optional end instruction,
variables, and agent options (engine, model options, vision, reasoning, step limit). `{{key}}` in the goal,
start and end text is replaced with the task's variables.

**Task memory** is the key/value facts a task keeps between runs (Memory tab on the task page). The agent sees
them in its instruction and changes them with the `save_memory` / `delete_memory` tools; each change is saved
as it happens, so a run that fails halfway still keeps what it learned.

### Runs

"Run now" or a schedule creates a run; the run page shows thoughts, actions, plans, memory changes, per-step
screenshots and the result live. Stop cancels the agent on the executor. Runs can be filtered, exported and
deleted.

### Databases (mcpocket.io)

Database channels are FIFO queues of JSON records, stored in [mcpocket.io](https://app.mcpocket.io).

- **In the UI**: create channels, import JSON (upload or paste, pick which keys to keep), browse and filter
  records by status, edit, reset, bulk-delete and export.
- **Channel-bound tasks**: bind a task to a channel and every run claims the next pending record. The record's
  fields become variables (usable as `{{key}}`) and are listed in the instruction. When the run ends the record
  is settled: succeeded → `completed`, failed → `failed`, cancelled or lost → back to `pending`.
- **Worker API** for external processes, per channel:

  | Call                                    | Does                                                    |
  | --------------------------------------- | ------------------------------------------------------- |
  | `GET\|POST /api/db/<channel>/get`        | claim the oldest pending record (atomic, FIFO)          |
  | `POST /api/db/<channel>/add`            | add one or many records                                 |
  | `POST /api/db/<channel>/set/<id>`       | set a record's status and result                        |
  | `POST /api/db/<channel>/undo/<id>`      | release a claim so the record is handed out again       |

  Set `DB_API_TOKEN` to require `Authorization: Bearer <token>` on `/api/db/*`.

Connect it by entering an mcpocket API key with the `operator` role on the Settings page (or `MCPOCKET_API_KEY`).
Settings has a connection check. Full contract in [docs/specs/db-channels.md](docs/specs/db-channels.md).

### Schedules

Each schedule runs one task on one device, in one of two modes:

- **interval** — repeats a set time after the previous run finished. While the device is busy or offline it
  waits and retries within seconds, without recording anything.
- **queue** — no timer. The schedule takes a position in its device's rotation and runs whenever the device is
  free, then goes to the back. A device cycles through its queue schedules forever. A due interval schedule
  outranks the rotation; a queue schedule whose channel is empty is passed over.

Both modes stop at `maxRuns` or after `maxFails` failures in a row. One device runs one task at a time.
`SCHEDULE_ACTIVE=false` pauses all schedules while "run now" keeps working. See
[docs/specs/schedule-queue-mode.md](docs/specs/schedule-queue-mode.md).

### App cards

Notes about how a particular app works (where things are, what to avoid), matched by package name. mobilerun's
planner reads them when reasoning is on; with reasoning off they are appended to the instruction. Jev sees the
card of the app in the foreground.

### Agents: mobilerun or Jev mode

Each task picks the engine that drives the phone under Agent options:

- **mobilerun** (default): the framework's agent with the LLM from the framework config. Vision, reasoning,
  prompt overrides, app cards and the memory tools apply.
- **TypeSafe Jev**: a port of [droidrun/mobile-jev](https://github.com/droidrun/mobile-jev) running in the
  executor over adb and Portal (no Mobilerun cloud device needed). Each step, code lists the controls on screen
  and Jev picks one operation (open app, tap, type, scroll, back, home, enter, wait, done, blocked) and its
  target in a single request. Code checks that the target is unchanged before acting and never retries an
  action whose outcome is uncertain. Set `TYPESAFE_API_KEY` on the executor; Settings shows whether it is
  configured.

To use Jev through [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) instead, set
`TYPESAFE_BASE_URL=https://openrouter.ai/api`; the executor then uses `OPENROUTER_API_KEY` unless
`TYPESAFE_API_KEY` is set.

Jev types only exact text: spans of up to eight words from the goal, plus the values of the task's variables
and memory, so put field values that are not in the goal in a variable. It reads variables, memory and the
foreground app card, but cannot change memory; vision, reasoning and prompt overrides do not apply. Jev's
"done" is the model's claim, not independent verification. Start URLs, end steps, stop, screenshots,
schedules and database channels work as for mobilerun.

## Prerequisites

- Node 22+ and [uv](https://docs.astral.sh/uv/).
- `adb` on your PATH with phones authorised for USB debugging (`adb devices` must list them as `device`).
- MongoDB, either through Docker (`docker compose up -d mongo`) or a local install:
  `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`.
- A mobilerun config with an LLM provider and API key. Run `uv tool install mobilerun && mobilerun setup` once,
  or point `MOBILERUN_CONFIG` at a config file. The executor reads the same config the `mobilerun` CLI uses
  (`~/Library/Application Support/droidrun/config.yaml` on macOS). See the
  [configuration docs](https://docs.mobilerun.ai/framework/sdk/configuration).
- Optional: an [mcpocket.io](https://app.mcpocket.io) operator key for the Database section, a
  [TypeSafe](https://console.typesafe.ai) key for Jev mode.

## Setup

```bash
cp .env.example .env            # set EXECUTOR_TOKEN to any secret string
npm install
(cd api && uv sync --extra dev)
```

## Run in development

```bash
make dev        # MongoDB (Docker or Homebrew) + executor + app, Ctrl+C stops all
make check      # typecheck, lint and both test suites
```

Or each process by hand:

```bash
docker compose up -d mongo                  # 1. MongoDB (or: brew services start mongodb-community)
EXECUTOR_TOKEN=change-me npm run executor   # 2. executor on the host, port 8765
npm run dev                                 # 3. app on http://localhost:3000
```

The executor runs on the host so it can see USB phones. Open Settings to confirm the executor is reachable,
which model is configured and whether mcpocket is connected, then Devices to see your phones.

## Full stack in Docker

`docker compose --profile full up --build` also runs the app and the executor in containers, for development:
the repo is bind-mounted, so Next.js hot-reloads and the executor restarts when a Python file in `api/executor`
or `api/mobilerun` changes. `node_modules` and `.next` live in container volumes, and `node_modules` is
reinstalled on start whenever `package-lock.json` has changed. After changing `api/uv.lock`, run
`docker compose build executor`.

The framework config is seeded from `config/mobilerun.yaml` into a volume on first start; set
`MOBILERUN_CONFIG_DIR` to a host directory containing `config.yaml` to use your own. Phones must be reachable
from the container: over network adb (`docker compose exec executor adb connect <ip>:5555`), or through an adb
server on the host (see `docker-compose.yml`), since a container cannot see USB devices on macOS or WSL.

## Production: one container

`Dockerfile.aio` builds a single image with the executor and the app, supervised together; only port 3000 is
published. MongoDB is not included: point `MONGODB_URI` at a hosted cluster (e.g. MongoDB Atlas).

```bash
docker build -f Dockerfile.aio -t mobilerun:latest .
docker run -d -p 3000:3000 -v mobilerun-config:/config \
  -e MONGODB_URI='mongodb+srv://...' -e OPENROUTER_API_KEY=... mobilerun:latest
```

Or `docker compose -f docker-compose.prod.yml up -d --build`. See [docker/README.md](docker/README.md) for
USB/adb and day-to-day operation.

## How a run works

1. "Run now", an interval tick or queue dispatch creates a run document and enqueues an Agenda job. For a
   channel-bound task, the next pending record is claimed first.
2. The job takes the device lock, opens the start URL through an adb intent, and starts the agent on the
   executor with the composed instruction, task options, variables (record fields included) and memory, plus
   the prompt overrides from Settings and the app cards.
3. The executor streams events (thoughts, actions, plans, step screenshots, memory changes, result); the job
   writes them to MongoDB, step images to GridFS (pruned per the retention setting), and pushes them to the run
   page over SSE.
4. When the run ends, its database record is settled and the schedule plans its next turn.
5. After a server restart, in-flight runs reattach to the executor's stream from the last stored event; a run is
   marked lost only when the executor no longer knows it.

## Tests and checks

```bash
npm test                # Next.js routes and jobs against in-memory MongoDB, a fake executor and a fake mcpocket
npm run test:executor   # executor HTTP contract against a scripted fake framework
npm run test:live       # smoke test against a real mcpocket
npm run check           # typecheck + lint + both test suites
```

## Environment variables

| Variable            | Used by  | Meaning                                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `MONGODB_URI`       | app      | MongoDB connection string                                                                     |
| `MONGODB_DB`        | app      | Database name; overrides the database in `MONGODB_URI` when set                               |
| `EXECUTOR_URL`      | app      | Base URL of the executor, default `http://127.0.0.1:8765`                                     |
| `EXECUTOR_TOKEN`    | both     | Shared secret sent as `X-Mobilerun-Token`; the executor refuses to start without it           |
| `SCHEDULE_ACTIVE`   | app      | `false` pauses schedules ("run now" still works); unset means active                          |
| `DB_API_TOKEN`      | app      | When set, `/api/db/*` requires `Authorization: Bearer <token>`                                |
| `MCPOCKET_API_KEY`  | app      | mcpocket operator key; fallback when none is saved on the Settings page                       |
| `MCPOCKET_URL`      | app      | mcpocket MCP endpoint, default `https://app.mcpocket.io/api/mcp`                              |
| `MCPOCKET_AGENT_ID` | app      | Identity this install claims records as, default `mobilerun`                                  |
| `EXECUTOR_HOST`     | executor | Bind address, default `127.0.0.1`                                                             |
| `EXECUTOR_PORT`     | executor | Port, default `8765`                                                                          |
| `MOBILERUN_CONFIG`  | executor | Optional path to a mobilerun config file                                                      |
| `OPENROUTER_API_KEY`| executor | Required when LLM profiles use OpenRouter; also used by Jev through OpenRouter                |
| `TYPESAFE_API_KEY`  | executor | Enables Jev mode; get a key from the [TypeSafe console](https://console.typesafe.ai)          |
| `TYPESAFE_MODEL`    | executor | Jev model, default `jev-latest`; pin a fixed version when comparing runs                      |
| `TYPESAFE_BASE_URL` | executor | Jev API base, default `https://api.typesafe.ai`; `https://openrouter.ai/api` for OpenRouter   |

## Troubleshooting

- **Executor unreachable** on Settings: it is not running, `EXECUTOR_URL` is wrong, or the tokens differ.
- **No devices**: run `adb devices`; `unauthorized` means the phone has not accepted the USB debugging prompt.
- **Run fails immediately with a config error**: the mobilerun config has no API key for the configured
  provider. Run `mobilerun setup` or `mobilerun configure <provider>`.
- **Database pages say mcpocket is not configured**: enter an operator key on Settings and run the connection
  check.
- **Runs are skipped**: the phone is too hot or its battery is below the minimum in Settings, or the task's
  channel has no pending records.
- **Screenshots are slow**: raise the refresh interval in Settings; each refresh is one adb screencap.

## Layout

- `app/` pages and route handlers, `components/` UI, `lib/` data access, jobs, the executor and mcpocket
  clients, `tests/` Vitest.
- `api/executor/` the FastAPI service (`jev/` is Jev mode), `api/mobilerun/` the vendored framework,
  `api/tests/` pytest.
- `docs/specs/` feature specs: device task runner, DB channels, schedule queue mode.
