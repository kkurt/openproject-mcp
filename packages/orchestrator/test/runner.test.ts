import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { agentEnv, buildClaudeArgs, builtInTools, runClaude, type RunnerOptions } from '@openproject-agent/orchestrator';

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

  it('limits the available built-in tools to the allowed ones', () => {
    const args = buildClaudeArgs({ ...baseOpts, allowedTools: ['Read', 'Bash(npm test:*)', 'mcp__openproject'] });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Bash');
  });

  it('passes --setting-sources only when configured ([] -> "" loads no settings files)', () => {
    expect(buildClaudeArgs(baseOpts)).not.toContain('--setting-sources');
    const none = buildClaudeArgs({ ...baseOpts, settingSources: [] });
    expect(none[none.indexOf('--setting-sources') + 1]).toBe('');
    const some = buildClaudeArgs({ ...baseOpts, settingSources: ['user', 'project'] });
    expect(some[some.indexOf('--setting-sources') + 1]).toBe('user,project');
  });
});

describe('builtInTools', () => {
  it('strips MCP tools and permission patterns, de-duplicating names', () => {
    expect(builtInTools(['Read', 'Edit', 'Bash(npm test:*)', 'Bash(npm run lint)', 'mcp__openproject', 'WebFetch(domain:x.dev)'])).toEqual([
      'Read',
      'Edit',
      'Bash',
      'WebFetch',
    ]);
    expect(builtInTools(['mcp__openproject'])).toEqual([]);
  });

  it('handles path-scoped rules and surrounding whitespace', () => {
    expect(builtInTools(['Read(./**)', ' Edit(./**) ', 'Bash(npm test:*) '])).toEqual(['Read', 'Edit', 'Bash']);
  });
});

describe('agentEnv', () => {
  it('removes OPENPROJECT_* variables (any case) and keeps the rest', () => {
    const env = { PATH: '/bin', OPENPROJECT_API_KEY: 'secret', OPENPROJECT_URL: 'https://op.test', openproject_readonly: 'x', ANTHROPIC_API_KEY: 'a' };
    expect(agentEnv(env)).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'a' });
  });

  it('also removes any variable whose value is the API key', () => {
    expect(agentEnv({ PATH: '/bin', MY_OP_TOKEN: 'k123', OTHER: 'x' }, 'k123')).toEqual({ PATH: '/bin', OTHER: 'x' });
    expect(agentEnv({ PATH: '/bin', EMPTY: '' }, '')).toEqual({ PATH: '/bin', EMPTY: '' });
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
