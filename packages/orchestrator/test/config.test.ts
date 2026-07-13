import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, maskSecret, redact, resolveEnvRefs, type AppConfig } from '@openproject-agent/orchestrator';

let dir: string;
let configPath: string;

const baseConfig = {
  openproject: { url: 'https://op.test', apiKey: 'env:OPENPROJECT_API_KEY' },
  project: 'demo',
  targetRepo: '.',
  filters: { types: ['Bug'], statuses: ['New'] },
  statusFlow: { start: 'In progress', success: 'Developed', blocked: 'On hold' },
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'op-cfg-'));
  configPath = path.join(dir, 'cfg.json');
  await writeFile(configPath, JSON.stringify({ ...baseConfig, targetRepo: dir }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveEnvRefs', () => {
  it('replaces env: refs across nested structures', () => {
    expect(resolveEnvRefs({ a: 'env:X', b: ['env:X', 'lit'], c: { d: 'env:X' } }, { X: '1' } as NodeJS.ProcessEnv)).toEqual({
      a: '1',
      b: ['1', 'lit'],
      c: { d: '1' },
    });
  });
  it('throws when a referenced env var is missing', () => {
    expect(() => resolveEnvRefs('env:MISSING', {} as NodeJS.ProcessEnv)).toThrow(/MISSING/);
  });
});

describe('loadConfig', () => {
  it('resolves env refs and applies defaults', async () => {
    const cfg = await loadConfig(configPath, { env: { OPENPROJECT_API_KEY: 'secret-key' } });
    expect(cfg.openproject.apiKey).toBe('secret-key');
    expect(cfg.order).toEqual([
      ['priority', 'desc'],
      ['id', 'asc'],
    ]);
    expect(cfg.protectedTransitions).toEqual(['Closed', 'Rejected']);
    expect(cfg.write).toBe(false);
    expect(cfg.claude.maxTurns).toBe(40);
    expect(cfg.claude.allowedTools).toContain('Read');
    expect(cfg.claude.disallowedTools).toContain('Bash(git:*)');
  });

  it('throws when an env ref is missing', async () => {
    await expect(loadConfig(configPath, { env: {} })).rejects.toThrow(/OPENPROJECT_API_KEY/);
  });

  it('lets OPENPROJECT_URL env override the file', async () => {
    const cfg = await loadConfig(configPath, {
      env: { OPENPROJECT_API_KEY: 'k', OPENPROJECT_URL: 'https://override.test' },
    });
    expect(cfg.openproject.url).toBe('https://override.test');
  });
});

describe('secret helpers', () => {
  it('masks a secret and tolerates undefined', () => {
    expect(maskSecret('key is abc123 here', 'abc123')).toBe('key is *** here');
    expect(maskSecret('nothing', undefined)).toBe('nothing');
  });

  it('redacts the apiKey', () => {
    const cfg = {
      openproject: { url: 'https://op.test', apiKey: 'super-secret' },
      project: 'p',
      targetRepo: 't',
      filters: {},
      order: [],
      statusFlow: { start: 'a', success: 'b', blocked: 'c' },
      protectedTransitions: [],
      write: false,
      claude: { binPath: 'claude', maxTurns: 1, timeoutMs: 1, allowedTools: [], disallowedTools: [], addDirs: [] },
    } as unknown as AppConfig;
    expect(redact(cfg).openproject.apiKey).toBe('***');
    // original is untouched
    expect(cfg.openproject.apiKey).toBe('super-secret');
  });
});
