# openproject-agent

A pnpm monorepo that connects **OpenProject** to **Claude Code**:

| Package | What it is |
| --- | --- |
| [`@openproject-agent/core`](packages/core) | OpenProject API v3 client — typed errors, HAL→DTO mapping, pagination, retry/backoff, lockVersion handling. |
| [`@openproject-agent/mcp`](packages/mcp) | An MCP (stdio) server exposing OpenProject as tools Claude Code can call. |
| [`@openproject-agent/orchestrator`](packages/orchestrator) | A CLI that pulls work packages, runs **headless Claude Code** (`claude -p`) against each, and writes the result back as a comment + status change. |

The design goal is **safe, authorized automation**: dry-run by default, protected status
transitions blocked, no git operations, secrets never logged.

> **Unofficial community project.** Not affiliated with, endorsed by, or sponsored by
> OpenProject GmbH or Anthropic PBC. OpenProject, Claude and Claude Code are trademarks of
> their respective owners.

---

## Prerequisites

- **Node.js 20+** (developed on 24)
- **pnpm** (`npm i -g pnpm`)
- **Claude Code CLI** (`claude`) available on your `PATH` — the orchestrator shells out to it.
- An **OpenProject** instance and an **API key**.

## Install & build

```bash
pnpm install
pnpm build        # tsc --build across all packages
pnpm test         # vitest (mocked; no network)
pnpm lint         # eslint
```

## Get an OpenProject API key

In OpenProject: **My account → Access tokens → API → Generate**. The key is used as the
HTTP Basic **password** with the fixed username `apikey`
(`Authorization: Basic base64("apikey:" + KEY)`).

## Configure

1. Copy the env template and fill it in (never commit the real `.env`):

   ```bash
   cp .env.example .env
   # edit .env -> OPENPROJECT_URL, OPENPROJECT_API_KEY
   ```

2. Edit [`openproject-agent.config.json`](openproject-agent.config.json). Key fields:

   - `project` — your project id or identifier.
   - `targetRepo` — absolute path to the repo Claude Code should work in.
   - `filters` — which work packages to pull (`types`, `statuses`, `assignee: "me"`, ...).
   - `statusFlow` — `{ start, success, blocked }` status names the orchestrator advances to.
   - `protectedTransitions` — statuses that always require human approval (default `Closed`, `Rejected`).
   - `claude.allowedTools` / `disallowedTools` — the tools spawned Claude Code may use.
   - `claude.maxTurns` — turn cap (see note below).
   - `commentFooter` — Markdown appended to every result comment (defaults to an English
     "produced by an AI agent, must be reviewed by a human" note; `""` omits it).

   `apiKey` is written as `"env:OPENPROJECT_API_KEY"` and resolved from the environment; the
   raw key is never stored in the config file.

---

## Use the MCP server with Claude Code

Build first (`pnpm build`). Then register the stdio server — **prefer `-s user` scope**
(one registration, available in every project, immune to the Windows drive-letter-casing
pitfall described in Troubleshooting):

**Windows (PowerShell — single line):**

```powershell
claude mcp add openproject -s user -e OPENPROJECT_URL=https://openproject.example.com -e OPENPROJECT_API_KEY=your-api-key -- node C:/absolute/path/to/openproject-mcp/packages/mcp/dist/bin.js
```

**macOS/Linux (bash):**

```bash
claude mcp add openproject -s user \
  -e OPENPROJECT_URL=https://openproject.example.com \
  -e OPENPROJECT_API_KEY=your-api-key \
  -- node /absolute/path/to/openproject-mcp/packages/mcp/dist/bin.js
```

> ⚠️ **Start a NEW Claude Code session after registering.** MCP tools are snapshotted at
> session start — an already-open chat will never gain the `mcp__openproject__*` tools,
> even if `claude mcp list` says Connected.

**Both env vars are mandatory** (`OPENPROJECT_URL`, `OPENPROJECT_API_KEY`) — but if either
is missing from the registration, the server falls back to a `.env` file, searched in this
order: `$OPENPROJECT_ENV_FILE`, `./.env` (cwd), the package's `.env`, this repo's `.env`.
Set `OPENPROJECT_NO_ENV_FILE=1` to disable the fallback. Optional env:
`OPENPROJECT_READONLY=true` (block all writes),
`OPENPROJECT_PROTECTED_TRANSITIONS=Closed,Rejected`, and `OPENPROJECT_START_STATUS="In progress"`
(the status `start_work_package` moves a work package to).

Or add a project-scoped `.mcp.json` (checked into a repo Claude Code runs in). Use
`${VAR}` expansion so the key never lands in a committed file, and note the server must
also be approved via `enabledMcpjsonServers` in that repo's `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "openproject": {
      "command": "node",
      "args": ["C:/absolute/path/to/openproject-mcp/packages/mcp/dist/bin.js"],
      "env": {
        "OPENPROJECT_URL": "https://openproject.example.com",
        "OPENPROJECT_API_KEY": "${OPENPROJECT_API_KEY}",
        "OPENPROJECT_READONLY": "true"
      }
    }
  }
}
```

> Set the referenced variable once per machine (Windows: `setx OPENPROJECT_API_KEY "..."`,
> then open a **new** terminal). Never commit a literal key. Pick exactly ONE registration
> path (user scope **or** `.mcp.json`) — duplicate registrations across scopes make
> failures very hard to diagnose. When you remove a `.mcp.json` entry, also remove the
> stale name from `enabledMcpjsonServers`.

### Troubleshooting

**First step, always:** run the built-in self-test in a real terminal —

```powershell
node C:/absolute/path/to/openproject-mcp/packages/mcp/dist/bin.js --doctor
```

It prints which `OPENPROJECT_*` vars are set (masked), where `.env` was searched/loaded,
performs a live auth + project-listing round-trip, and ends with a one-line fix hint.

- **"Failed to connect"** — the server process crashed at startup. Almost always a missing
  `OPENPROJECT_URL`/`OPENPROJECT_API_KEY` in the registration env (and no `.env` found).
  `--doctor` shows exactly what is missing.
- **Tools missing in an open session** — tools load at session start; start a new session.
- **`claude mcp list` says Connected but the session says "Server not found"** (Windows) —
  drive-letter casing split-brain: `~/.claude.json` can hold *two* project entries for the
  same folder (`C:/...` and `c:/...`), and the registration may have landed in the one your
  session doesn't use. Fix: register with `-s user` (project-independent), and remove the
  duplicates (`claude mcp remove openproject -s local` run from the affected project).
- **Verifying inside a session** — run `/mcp` in Claude Code to see connected servers and
  their tools.

### Tools exposed

**Read:** `list_projects`, `list_work_packages`, `get_work_package`, `get_next_work_package`,
`list_statuses`, `list_types`, `list_priorities`, `get_allowed_status_transitions`,
`get_journal` (full change history incl. "Status changed from X to Y" lines),
`get_work_package_schema` (field types, required/writable, custom fields),
`get_attachment` (images are returned as viewable image content; text files are inlined).

**Boards:** `list_boards`, `get_board`, `list_board_column`, `get_next_board_card`
(boards are status-based Kanban boards; each column is a saved query).

**Write** (each supports a `dryRun` flag and honors global read-only mode):
`add_comment`, `update_work_package_status`, `start_work_package` (move a WP to the start
status, default "In progress" — call when you begin work), `create_work_package`,
`assign_work_package`, `log_time`.

Critical transitions in `protectedTransitions` are refused with a "human approval required"
error, and work-package deletion is never exposed.

---

## Use the orchestrator

```bash
# Show the queue without running anything
node packages/orchestrator/dist/cli.js list

# Dry run (DEFAULT): Claude Code runs, but OpenProject is NOT written
node packages/orchestrator/dist/cli.js run --wp 1234

# Really write results back to OpenProject
node packages/orchestrator/dist/cli.js run --write --yes --limit 3

# State summary / reset
node packages/orchestrator/dist/cli.js status
node packages/orchestrator/dist/cli.js reset
```

`run` flags: `--project <id>`, `--types bug,feature`, `--limit <n>`, `--wp <id>`,
`--board <name>`, `--column <name>`, `--dry-run` (default), `--write`, `--yes` (no per-WP
prompt), `--max-turns <n>`, `--verbose`, `--config <path>`, `--template <path>`.

### Board mode

Instead of `filters.statuses`, you can drive the queue from a **board column**. Add a
`board` block to the config (or pass `--board`/`--column`):

```json
"board": { "name": "Kanban", "sourceColumn": "New" }
```

The queue is pulled from that column via its saved query (preserving board order), then
still narrowed by `filters.types` / `filters.assignee`. Because these are status-based
boards, advancing a card across columns is just a status change — so `statusFlow` already
moves cards on the board. Board names are unique only within a project, so the board is
resolved within `config.project`.

**Per work package** the orchestrator: fetches full detail → renders
[`templates/work-package.md`](templates/work-package.md) → runs `claude -p --output-format
stream-json` in `targetRepo` (with this MCP server wired in via `--mcp-config`) → logs the
stream to `.openproject-agent/logs/wp-<id>.jsonl` → parses the agent's JSON result block →
in `--write` mode, posts a review comment and advances status per `statusFlow` → records
progress in `.openproject-agent/state.json`. Runs are **sequential** (concurrency 1) and
**resumable** (already-finished work packages are skipped).

---

## Safety notes

- **Dry-run is the default.** Writing to OpenProject requires `--write` (or `write: true` in
  config). In dry-run the MCP server is passed `OPENPROJECT_READONLY=true`.
- **Protected transitions** (e.g. `Closed`, `Rejected`) are never performed automatically,
  by either the MCP server or the orchestrator.
- **No git.** The prompt forbids git commands and the runner passes `--disallowedTools
  "Bash(git:*)"`; only the working tree is modified.
- **Secrets** are never written to the repo, logs, or state; the API key is masked in output.
- **Unknown results** (no structured result block) are routed to human review, not
  auto-advanced.

### Note on `maxTurns`

Claude Code has **no `--max-turns` CLI flag** (verified against v2.1.186). The orchestrator
enforces `claude.maxTurns` itself by counting `assistant` turns in the `stream-json` output
and terminating the child process if it is exceeded; a wall-clock `timeoutMs` is a safety net.

---

## Project layout

```
packages/core/          OpenProject API client, DTOs, retry, errors
packages/mcp/           MCP stdio server (uses core)
packages/orchestrator/  CLI, prompt rendering, Claude runner, state store
templates/work-package.md
openproject-agent.config.json
```

## Testing

`pnpm test` runs the full suite with **msw**-mocked HTTP and an in-memory MCP client — no
live OpenProject or Claude Code process is needed. `pnpm build` (tsc) and `pnpm lint` must
also pass.

## License

[MIT](LICENSE) © 2026 Kürşat Kurt
