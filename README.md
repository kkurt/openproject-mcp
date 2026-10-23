# openproject-agent

A pnpm monorepo that connects **OpenProject** to **Claude Code**:

| Package | What it is |
| --- | --- |
| [`@openproject-agent/core`](packages/core) | OpenProject API v3 client — typed errors, HAL→DTO mapping, pagination, retry/backoff, lockVersion handling. |
| [`@openproject-agent/mcp`](packages/mcp) | An MCP (stdio) server exposing OpenProject as tools Claude Code can call. |
| [`@openproject-agent/orchestrator`](packages/orchestrator) | A CLI that pulls work packages, runs **headless Claude Code** (`claude -p`) against each, and writes the result back as a comment + status change. |

The design goal is **guarded automation**: dry-run by default, protected status transitions
blocked, file access scoped to the target repo, and the API key kept out of logs and out of
the agent's environment. These are guardrails, not a sandbox: read the
[Security model](#security-model) before pointing the orchestrator at a real repository.

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
   - `claude.allowedTools` / `disallowedTools` — the tools spawned Claude Code may use;
     built-in tools not listed in `allowedTools` are not available at all. The default scopes
     file tools to the target repo (`Read(./**)`, `Edit(./**)`, ...); a bare `Read` or `Edit`
     would allow every file your OS user can access. `claude.addDirs` widens the scope.
   - `claude.settingSources` — which Claude Code settings files (`user`, `project`, `local`)
     the agent loads; default `[]` (none). See [Security model](#security-model).
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
`update_work_package` (edit subject, description — replace or append — dates, estimate, % done,
priority, assignee, accountable, parent and custom fields; `null` clears a field; dryRun returns a
before/after diff plus the validation errors OpenProject would raise; pass `lockVersion` from
`get_work_package` to have a concurrent edit reported instead of overwritten),
`assign_work_package`, `log_time`.

Custom fields are keyed by `customField<N>` or display name, and list fields take option names
or ids (an array for multi-select):

```json
{ "workPackageId": 348, "customFields": { "Related": ["MetaSync", "MetaAddIn"] }, "dryRun": true }
```

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

## Security model

**Read this before running the orchestrator.** It feeds OpenProject content (subject,
description, assignee name, comments, relation titles, attachment names, and whatever the
agent later reads through attachments or the `openproject` tools) into an autonomous Claude
Code session that edits files in `targetRepo`. **Anyone who can write content the API key can
read — work packages, comments or attachments, including related work packages in other
projects — can try to steer that agent (prompt injection).** Assume they can run code on the
orchestrator host:

- The default `allowedTools` include `Edit`, `Write` and `Bash(npm test:*)`. `npm test` runs
  whatever the repo's test script and test files say, and the agent can edit both, so an
  allowed test command amounts to arbitrary code execution as your OS user.
- **Dry-run does not prevent this.** It only stops writes to OpenProject; the agent still
  edits files in `targetRepo` and runs its allowed commands.
- In `--write` mode every field of the agent's result block (`summary`, `changedFiles`,
  `openQuestions`, `testsRun`) — or up to 4000 characters of its final message when there is
  no result block — is posted as a comment everyone in the project can read. That is a
  possible channel for leaking file contents.
- All work packages in one run share the same `targetRepo` working tree, so changes a
  poisoned run leaves behind (e.g. to `CLAUDE.md` or tests) carry into the next run.

Recommended setup:

- Run the orchestrator in a disposable container, VM or devcontainer with no other
  credentials and restricted network egress, against a throwaway clone or worktree. Keep
  the API key out of files on that machine where you can (see below).
- Use a dedicated low-privilege OpenProject account whose API key can only see the target
  project.
- Make sure only trusted people can write the content that gets queued: a project where only
  trusted users may create, edit, comment on or attach to work packages, or a status/type in
  the workflow that only trusted roles can set. `filters.assignee` and board columns choose
  *which* work packages run, not *who* wrote their content.
- Keep `allowedTools` minimal and path-scoped, stay in dry-run until you trust the setup, and
  review the diff after each work package (e.g. `--limit 1` against a clean checkout) when
  the queue is not fully trusted.

What the orchestrator does to limit the blast radius:

- **Fenced input.** Work-package text embedded in the prompt is wrapped in
  `<untrusted-content>` tags, and the prompt tells the agent to treat those, attachments and
  `openproject` tool results as data. This lowers the risk of prompt injection; it does not
  remove it.
- **Only allowed tools exist, scoped to the repo.** Built-in tools not listed in
  `claude.allowedTools` are removed from the session (`--tools`), `disallowedTools` (default
  `Bash(git:*)`) are denied, and the default file-tool rules (`Read(./**)` etc.) refuse paths
  outside `targetRepo` and `claude.addDirs`. Commands run through an allowed `Bash` rule are
  not confined this way.
- **Isolated settings.** `claude.settingSources` defaults to `[]`, so nothing from your user,
  project or local Claude Code settings files applies to unattended runs: no hooks, plugins
  or allow-rules — but also no **deny rules**, sandbox or model settings, and the repo's
  `CLAUDE.md` is not auto-loaded (the default template tells the agent to read it). Put
  restrictions in `claude.disallowedTools`, which always applies. Adding a source (e.g.
  `["user"]` when your Claude Code auth comes from `apiKeyHelper` or `env` in a settings file)
  brings back that file's hooks, plugins and rules too. Never add `project` or `local` for an
  untrusted queue: the agent can edit those files inside `targetRepo`.
- **Read-only OpenProject access for the agent.** Its MCP server always runs with
  `OPENPROJECT_READONLY=true`; every OpenProject write is made by the orchestrator itself, and
  only in `--write` mode. `OPENPROJECT_*` variables (and any variable holding the key) are
  removed from the agent's environment, so commands it runs do not inherit the API key. Code
  running as your OS user can still read it from the files that hold it — the temporary MCP
  config file and your `.env` — hence the recommendations above.
- **Masking.** The API key is masked in the orchestrator's log output, in the
  `.openproject-agent/logs/wp-<id>.jsonl` transcripts and in posted comments. Only the exact
  key is caught: this stops accidental leaks, not a steered agent that encodes it.
  Transcripts otherwise contain repository content verbatim; treat them as sensitive.
- **Protected transitions** (default `Closed`, `Rejected`) are never performed automatically,
  by either the MCP server or the orchestrator.
- **No git.** The prompt forbids git and the runner denies `Bash(git:*)`. This keeps a
  well-behaved agent out of git; it is not a boundary against code run through another
  allowed command.
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
