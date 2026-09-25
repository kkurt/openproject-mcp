/**
 * Headless Claude Code runner. Spawns `claude -p --output-format stream-json`,
 * feeds the prompt via stdin, streams and logs events, counts assistant turns,
 * and terminates the child if it exceeds maxTurns or the wall-clock timeout.
 *
 * NOTE: Claude Code has no --max-turns flag (verified against v2.1.186), so the
 * cap is enforced here by counting `assistant` events in the stream.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export type StreamEvent = Record<string, unknown> & { type?: string };

export interface ChildLike {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

export interface RunnerOptions {
  binPath: string;
  prompt: string;
  cwd: string;
  /** Path to the temp --mcp-config file. */
  mcpConfigPath: string;
  allowedTools: string[];
  disallowedTools: string[];
  /**
   * Claude Code setting sources to load (user, project, local). Omit to keep the
   * CLI default (all); [] isolates the run from every settings file, so hooks,
   * plugins and permission allow-rules there cannot widen the agent's rights.
   */
  settingSources?: string[];
  addDirs?: string[];
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  /** Called for every stdout line (raw + parsed if JSON). Use to persist a jsonl log. */
  onLine?: (raw: string, event: StreamEvent | null) => void;
  /** Called with each assistant text chunk (verbose streaming). */
  onText?: (text: string) => void;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerResult {
  exitCode: number | null;
  finalText: string;
  turns: number;
  sessionId?: string;
  killedReason?: 'maxTurns' | 'timeout';
  lineCount: number;
}

/**
 * Built-in tools to make available: the names in allowedTools, minus MCP tools
 * and permission patterns (`Bash(npm test:*)` -> `Bash`). Anything not allowed is
 * then absent from the session rather than merely unapproved.
 */
export function builtInTools(allowedTools: string[]): string[] {
  const names = allowedTools
    .filter((t) => !t.startsWith('mcp__'))
    .map((t) => t.trim().replace(/\(.*\)$/s, '').trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Copy of `env` without OPENPROJECT_* variables and without any variable holding
 * `secret` (the key may come from a differently named `env:VAR`). The agent
 * reaches OpenProject only through its MCP server.
 */
export function agentEnv(env: NodeJS.ProcessEnv, secret?: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => !key.toUpperCase().startsWith('OPENPROJECT_') && !(secret && value === secret),
    ),
  );
}

export function buildClaudeArgs(options: RunnerOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
    '--allowedTools',
    options.allowedTools.join(','),
    '--tools',
    builtInTools(options.allowedTools).join(','),
  ];
  if (options.settingSources) args.push('--setting-sources', options.settingSources.join(','));
  if (options.disallowedTools.length > 0) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir);
  if (options.model) args.push('--model', options.model);
  return args;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

export async function runClaude(options: RunnerOptions): Promise<RunnerResult> {
  const spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const args = buildClaudeArgs(options);
  const child = spawnFn(options.binPath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let turns = 0;
  let lineCount = 0;
  let finalText = '';
  let sessionId: string | undefined;
  let killedReason: 'maxTurns' | 'timeout' | undefined;

  const handleEvent = (ev: StreamEvent): void => {
    if (ev.type === 'system' && ev['subtype'] === 'init' && typeof ev['session_id'] === 'string') {
      sessionId = ev['session_id'];
    }
    if (ev.type === 'assistant') {
      turns += 1;
      const text = extractAssistantText(ev['message']);
      if (text) {
        finalText = text;
        options.onText?.(text);
      }
      if (turns > options.maxTurns && !killedReason) {
        killedReason = 'maxTurns';
        child.kill('SIGTERM');
      }
    }
    if (ev.type === 'result') {
      if (typeof ev['result'] === 'string') finalText = ev['result'];
      if (typeof ev['session_id'] === 'string') sessionId = ev['session_id'];
    }
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    lineCount += 1;
    let event: StreamEvent | null = null;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      event = null;
    }
    options.onLine?.(trimmed, event);
    if (event) handleEvent(event);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line);
    }
  });

  // Feed the prompt via stdin (avoids arg-length limits on Windows) and close it.
  child.stdin?.write(options.prompt);
  child.stdin?.end();

  const timer = setTimeout(() => {
    if (!killedReason) {
      killedReason = 'timeout';
      child.kill('SIGTERM');
    }
  }, options.timeoutMs);

  return await new Promise<RunnerResult>((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) processLine(buffer);
      resolve({ exitCode: code, finalText, turns, sessionId, killedReason, lineCount });
    });
  });
}
