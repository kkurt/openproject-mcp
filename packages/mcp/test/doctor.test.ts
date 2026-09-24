import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from '@openproject-agent/mcp';

function harness(env: NodeJS.ProcessEnv, clientOverrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const client = {
    getCurrentUser: vi.fn(async () => ({ id: 9, name: 'Kürşat', login: 'k', email: null })),
    listProjects: vi.fn(async () => [
      { id: 6, identifier: 'testproject', name: 'Test', active: true, description: null, url: 'u' },
    ]),
    ...clientOverrides,
  };
  return {
    lines,
    client,
    io: {
      log: (l: string) => lines.push(l),
      env,
      clientFactory: () => client as never,
    },
  };
}

describe('runDoctor', () => {
  it('fails fast with a hint when the API key is missing, and never prints secrets', async () => {
    // OPENPROJECT_NO_ENV_FILE isolates the test from the developer's real .env.
    const { io, lines } = harness({ OPENPROJECT_URL: 'https://op.test', OPENPROJECT_NO_ENV_FILE: '1' });
    const code = await runDoctor(io);
    expect(code).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain('OPENPROJECT_API_KEY is missing');
    expect(out).toContain('➜ Fix:');
    expect(out).toContain('.env search order:');
  });

  it('passes when auth and project listing succeed, masking the key', async () => {
    const { io, lines } = harness({ OPENPROJECT_URL: 'https://op.test', OPENPROJECT_API_KEY: 'opapSECRETSECRET' });
    const code = await runDoctor(io);
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('auth OK — logged in as: Kürşat');
    expect(out).toContain('1 project(s) visible: testproject');
    expect(out).toContain('opap… (len=16)');
    expect(out).not.toContain('opapSECRETSECRET');
    expect(out).toContain('Start a NEW Claude Code session');
  });

  it('returns 2 with a rotate hint on auth failure', async () => {
    const { AuthError } = await import('@openproject-agent/core');
    const { io, lines } = harness(
      { OPENPROJECT_URL: 'https://op.test', OPENPROJECT_API_KEY: 'bad' },
      { getCurrentUser: vi.fn(async () => { throw new AuthError('unauthorized', 401); }) },
    );
    const code = await runDoctor(io);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('the API key is wrong or revoked');
  });
});
