# openproject-agent

A pnpm monorepo that connects **OpenProject** to **Claude Code**:

| Package | What it is |
| --- | --- |
| [`@openproject-agent/core`](packages/core) | OpenProject API v3 client — typed errors, HAL→DTO mapping, pagination, retry/backoff, lockVersion handling. |
| [`@openproject-agent/mcp`](packages/mcp) | An MCP (stdio) server exposing OpenProject as tools Claude Code can call. |
| [`@openproject-agent/orchestrator`](packages/orchestrator) | A CLI that pulls work packages, runs **headless Claude Code** (`claude -p`) against each, and writes the result back as a comment + status change. |

The design goal is **safe, authorized automation**: dry-run by default, protected status
transitions blocked, no git operations, secrets never logged.

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

   `apiKey` is written as `"env:OPENPROJECT_API_KEY"` and resolved from the environment; the
   raw key is never stored in the config file.

---

## Use the MCP server with Claude Code

Build first (`pnpm build`), then register the stdio server. The path below points at the
built bin:

```bash
claude mcp add openproject \
  -e OPENPROJECT_URL=https://openproject.example.com \
  -e OPENPROJECT_API_KEY=your-api-key \
  -- node ./packages/mcp/dist/bin.js
```

Optional env: `OPENPROJECT_READONLY=true` (block all writes),
`OPENPROJECT_PROTECTED_TRANSITIONS=Closed,Rejected`, and `OPENPROJECT_START_STATUS="In progress"`
(the status `start_work_package` moves a work package to).

Or add a project-scoped `.mcp.json` (checked into a repo Claude Code runs in):

```json
{
  "mcpServers": {
    "openproject": {
      "command": "node",
      "args": ["/absolute/path/to/openproject-mcp/packages/mcp/dist/bin.js"],
      "env": {
        "OPENPROJECT_URL": "https://openproject.example.com",
        "OPENPROJECT_API_KEY": "your-api-key",
        "OPENPROJECT_READONLY": "true"
      }
    }
  }
}
```

> Prefer environment variables over hard-coding the API key in `.mcp.json`; if you must,
> keep that file out of version control.

### Tools exposed

**Read:** `list_projects`, `list_work_packages`, `get_work_package`, `get_next_work_package`,
`list_statuses`, `list_types`, `list_priorities`, `get_allowed_status_transitions`,
`get_attachment` (images are returned as viewable image content; text files are inlined).

**Boards:** `list_boards`, `get_board`, `list_board_column`, `get_next_board_card`
(boards are status-based Kanban boards; each column is a saved query).

**Write** (each supports a `dryRun` flag and honors global read-only mode):
`add_comment`, `update_work_package_status`, `start_work_package` (move a WP to the start
status, default "In progress" — call when you begin work), `assign_work_package`, `log_time`.

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
"board": { "name": "MetaAdmin", "sourceColumn": "New" }
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
