#!/usr/bin/env node
/** openproject-agent CLI: run | list | status | reset. */
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { OpenProjectClient } from '@openproject-agent/core';
import { loadConfig, maskSecret, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { buildMcpConfig, resolveMcpServerBin } from './mcp-config.js';
import { runOrchestrator, type ConfirmDecision, type RunAgent, type RunSummary } from './orchestrator.js';
import { buildQueue } from './queue.js';
import { agentEnv, runClaude } from './runner.js';
import { StateStore } from './state.js';

const DEFAULT_CONFIG = 'openproject-agent.config.json';
const DEFAULT_TEMPLATE = 'templates/work-package.md';
const STATE_DIR = '.openproject-agent';

interface CommonOpts {
  config?: string;
  project?: string;
  verbose?: boolean;
}

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function fail(err: unknown): never {
  process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

async function assertDir(dir: string, label: string): Promise<void> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error(`${label} '${dir}' is not a directory`);
  } catch (err) {
    throw new Error(`${label} '${dir}' is not accessible: ${(err as Error).message}`);
  }
}

interface Bootstrapped {
  config: AppConfig;
  client: OpenProjectClient;
  state: StateStore;
  logger: Logger;
}

async function bootstrap(opts: CommonOpts & { write?: boolean }): Promise<Bootstrapped> {
  dotenv.config();
  const configPath = path.resolve(opts.config ?? DEFAULT_CONFIG);
  const config = await loadConfig(configPath);
  if (opts.project) config.project = opts.project;
  if (opts.write) config.write = true;
  const logger = createLogger({ verbose: opts.verbose, secret: config.openproject.apiKey });
  const client = new OpenProjectClient({ url: config.openproject.url, apiKey: config.openproject.apiKey });
  const state = new StateStore(path.resolve(STATE_DIR));
  await state.load();
  return { config, client, state, logger };
}

async function loadTemplate(templatePath: string | undefined): Promise<string> {
  const p = path.resolve(templatePath ?? DEFAULT_TEMPLATE);
  try {
    return await readFile(p, 'utf8');
  } catch {
    throw new Error(`Prompt template not found at ${p}. Create ${DEFAULT_TEMPLATE} or pass --template.`);
  }
}

/** Default agent runner: writes a temp --mcp-config, streams to a jsonl log, cleans up. */
function createClaudeRunner(
  config: AppConfig,
  deps: { logDir: string; logger: Logger; maxTurns: number },
): RunAgent {
  const serverPath = resolveMcpServerBin();
  // The sub-agent only READS OpenProject (for context/attachments); the orchestrator
  // owns all OpenProject writes. So its MCP server is always read-only.
  return async ({ wp, prompt }) => {
    const mcpConfig = buildMcpConfig({
      serverPath,
      url: config.openproject.url,
      apiKey: config.openproject.apiKey,
      readOnly: true,
      protectedTransitions: config.protectedTransitions,
    });
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'op-agent-'));
    const mcpConfigPath = path.join(tmpDir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });

    await mkdir(deps.logDir, { recursive: true });
    const logStream = createWriteStream(path.join(deps.logDir, `wp-${wp.id}.jsonl`), { flags: 'a' });
    try {
      return await runClaude({
        binPath: config.claude.binPath,
        prompt,
        cwd: config.targetRepo,
        mcpConfigPath,
        allowedTools: config.claude.allowedTools,
        disallowedTools: config.claude.disallowedTools,
        settingSources: config.claude.settingSources,
        addDirs: config.claude.addDirs,
        ...(config.claude.model ? { model: config.claude.model } : {}),
        maxTurns: deps.maxTurns,
        timeoutMs: config.claude.timeoutMs,
        // No OPENPROJECT_* vars: code the agent runs (e.g. `npm test`) must not see the
        // API key; the MCP server gets its settings from the --mcp-config env block.
        env: agentEnv(process.env, config.openproject.apiKey),
        onLine: (raw) => logStream.write(maskSecret(raw, config.openproject.apiKey) + '\n'),
        onText: (t) => deps.logger.debug(t),
      });
    } finally {
      logStream.end();
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

function makeConfirm(): { confirm: (id: number, subject: string) => Promise<ConfirmDecision>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    confirm: async (id, subject) => {
      const ans = (await rl.question(`Process WP ${id} "${subject}"? [P]rocess / [s]kip / [q]uit: `)).trim().toLowerCase();
      if (ans === 's' || ans === 'skip') return 'skip';
      if (ans === 'q' || ans === 'quit') return 'quit';
      return 'process';
    },
    close: () => rl.close(),
  };
}

function printSummary(s: RunSummary): void {
  process.stdout.write('\n--- Summary ---\n');
  process.stdout.write(
    `queued=${s.queued} processed=${s.processed} done=${s.done} blocked=${s.blocked} ` +
      `failed=${s.failed} needsReview=${s.needsReview} skipped=${s.skipped}${s.stopped ? ' (stopped)' : ''}\n`,
  );
}

const program = new Command();
program.name('openproject-agent').description('Run headless Claude Code against OpenProject work packages.');

program
  .command('run')
  .description('Process work packages sequentially.')
  .option('--config <path>', 'config file', DEFAULT_CONFIG)
  .option('--template <path>', 'prompt template', DEFAULT_TEMPLATE)
  .option('--project <id>', 'override project identifier')
  .option('--types <list>', 'comma-separated type names (override)')
  .option('--limit <n>', 'max work packages')
  .option('--wp <id>', 'process a single work package')
  .option('--board <name>', 'pull the queue from a board column')
  .option('--column <name>', 'board source column (default: leftmost)')
  .option('--dry-run', 'run Claude Code but do not write to OpenProject (default)')
  .option('--write', 'enable writes to OpenProject')
  .option('--yes', 'do not prompt before each work package')
  .option('--max-turns <n>', 'cap assistant turns per work package')
  .option('--verbose', 'verbose logging')
  .action(async (opts) => {
    try {
      const { config, client, state, logger } = await bootstrap(opts);
      const template = await loadTemplate(opts.template);
      await assertDir(config.targetRepo, 'targetRepo');

      const dryRun = !(opts.write || config.write);
      const maxTurns = opts.maxTurns ? Number(opts.maxTurns) : config.claude.maxTurns;
      const logDir = path.resolve(STATE_DIR, 'logs');

      if (dryRun) logger.info('DRY-RUN: Claude Code runs, but OpenProject will NOT be written. Use --write to enable writes.');
      else logger.warn('WRITE mode: agent results WILL be posted to OpenProject.');

      const runAgent = createClaudeRunner(config, { logDir, logger, maxTurns });
      const confirmer = opts.yes ? undefined : makeConfirm();
      try {
        const summary = await runOrchestrator(
          {
            client,
            config,
            state,
            logger,
            promptTemplate: template,
            runAgent,
            ...(confirmer ? { confirm: confirmer.confirm } : {}),
          },
          {
            dryRun,
            yes: Boolean(opts.yes),
            ...(opts.wp ? { wp: Number(opts.wp) } : {}),
            ...(opts.types ? { types: splitList(opts.types) } : {}),
            ...(opts.limit ? { limit: Number(opts.limit) } : {}),
            ...(opts.board ? { board: opts.board } : {}),
            ...(opts.column ? { column: opts.column } : {}),
          },
        );
        printSummary(summary);
      } finally {
        confirmer?.close();
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('list')
  .description('Show the queue without running anything.')
  .option('--config <path>', 'config file', DEFAULT_CONFIG)
  .option('--project <id>', 'override project identifier')
  .option('--types <list>', 'comma-separated type names (override)')
  .option('--limit <n>', 'max work packages')
  .option('--wp <id>', 'single work package')
  .option('--board <name>', 'pull the queue from a board column')
  .option('--column <name>', 'board source column (default: leftmost)')
  .option('--verbose', 'verbose logging')
  .action(async (opts) => {
    try {
      const { config, client, state } = await bootstrap(opts);
      const queue = await buildQueue(client, config, state, {
        ...(opts.wp ? { wp: Number(opts.wp) } : {}),
        ...(opts.types ? { types: splitList(opts.types) } : {}),
        ...(opts.limit ? { limit: Number(opts.limit) } : {}),
        ...(opts.board ? { board: opts.board } : {}),
        ...(opts.column ? { column: opts.column } : {}),
      });
      if (queue.length === 0) {
        process.stdout.write('Queue is empty.\n');
        return;
      }
      process.stdout.write(`Queue (${queue.length}):\n`);
      for (const wp of queue) {
        process.stdout.write(`  #${wp.id} [${wp.type ?? '?'}] (${wp.priority ?? '-'}) ${wp.status ?? '-'}  ${wp.subject}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('status')
  .description('Print a summary of state.json.')
  .action(async () => {
    try {
      const state = new StateStore(path.resolve(STATE_DIR));
      await state.load();
      const entries = Object.entries(state.all().workPackages);
      if (entries.length === 0) {
        process.stdout.write('No state recorded yet.\n');
        return;
      }
      const counts: Record<string, number> = {};
      for (const [, s] of entries) counts[s.status] = (counts[s.status] ?? 0) + 1;
      process.stdout.write('State summary:\n');
      for (const [k, v] of Object.entries(counts)) process.stdout.write(`  ${k}: ${v}\n`);
      process.stdout.write('\nWork packages:\n');
      for (const [id, s] of entries) {
        process.stdout.write(`  #${id}: ${s.status}${s.result ? ` (${s.result})` : ''}${s.error ? ` — ${s.error}` : ''}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('reset')
  .description('Clear run state.')
  .option('--yes', 'do not prompt')
  .action(async (opts) => {
    try {
      const state = new StateStore(path.resolve(STATE_DIR));
      await state.load();
      if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await rl.question('Clear all run state? [y/N]: ')).trim().toLowerCase();
        rl.close();
        if (ans !== 'y' && ans !== 'yes') {
          process.stdout.write('Aborted.\n');
          return;
        }
      }
      await state.clear();
      process.stdout.write('State cleared.\n');
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
