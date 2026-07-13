import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs, runClaude, type RunnerOptions } from '@openproject-agent/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChild = any;

function fakeChild(): AnyChild {
  const child: AnyChild = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinChunks = [];
  child.stdin = {
    write: (c: string) => {
      child.stdinChunks.push(c);
      return true;
    },
    end: () => {},
  };
  child.kill = vi.fn((sig?: string) => {
    setImmediate(() => child.emit('close', null, sig ?? 'SIGTERM'));
    return true;
  });
  return child;
}

function makeSpawn(opts: { events?: unknown[]; exitCode?: number; hang?: boolean; ref?: { child?: AnyChild } }) {
  return (_cmd: string, _args: readonly string[], _o: unknown): AnyChild => {
    const child = fakeChild();
    if (opts.ref) opts.ref.child = child;
    if (!opts.hang) {
      setImmediate(() => {
        child.stdout.on('end', () => child.emit('close', opts.exitCode ?? 0, null));
        for (const e of opts.events ?? []) child.stdout.write(JSON.stringify(e) + '\n');
        child.stdout.end();
      });
    }
    return child;
  };
}

const baseOpts: RunnerOptions = {
  binPath: 'claude',
  prompt: 'do the thing',
  cwd: '/repo',
  mcpConfigPath: '/tmp/mcp.json',
  allowedTools: ['Read', 'Edit'],
  disallowedTools: ['Bash(git:*)'],
  maxTurns: 40,
  timeoutMs: 60_000,
};

describe('buildClaudeArgs', () => {
  it('produces the expected headless flags', () => {
    const args = buildClaudeArgs(baseOpts);
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--strict-mcp-config',
        '--mcp-config',
        '/tmp/mcp.json',
        '--allowedTools',
        'Read,Edit',
        '--disallowedTools',
        'Bash(git:*)',
      ]),
    );
    // Verified: no --max-turns flag is emitted (it does not exist in the CLI).
    expect(args).not.toContain('--max-turns');
  });
});

describe('runClaude', () => {
  it('parses the stream, counts turns, and captures session + result', async () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } },
      { type: 'result', subtype: 'success', result: '{"result":"done","summary":"ok"}' },
    ];
    const result = await runClaude({ ...baseOpts, spawn: makeSpawn({ events, exitCode: 0 }) });
    expect(result.turns).toBe(2);
    expect(result.sessionId).toBe('sess-1');
    expect(result.finalText).toContain('"result":"done"');
    expect(result.exitCode).toBe(0);
    expect(result.killedReason).toBeUndefined();
  });

  it('feeds the prompt via stdin', async () => {
    const ref: { child?: AnyChild } = {};
    await runClaude({ ...baseOpts, prompt: 'HELLO', spawn: makeSpawn({ events: [{ type: 'result', result: 'x' }], ref }) });
    expect(ref.child?.stdinChunks.join('')).toBe('HELLO');
  });

  it('terminates the child when maxTurns is exceeded', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `t${i}` }] },
    }));
    const ref: { child?: AnyChild } = {};
    const result = await runClaude({ ...baseOpts, maxTurns: 2, spawn: makeSpawn({ events, ref }) });
    expect(result.killedReason).toBe('maxTurns');
    expect(ref.child?.kill).toHaveBeenCalled();
  });

  it('terminates on wall-clock timeout', async () => {
    const ref: { child?: AnyChild } = {};
    const result = await runClaude({ ...baseOpts, timeoutMs: 40, spawn: makeSpawn({ hang: true, ref }) });
    expect(result.killedReason).toBe('timeout');
    expect(ref.child?.kill).toHaveBeenCalled();
  });
});
