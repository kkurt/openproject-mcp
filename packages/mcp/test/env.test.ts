import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnvFallback, maskValue, parseEnvFile } from '@openproject-agent/mcp';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, ignores comments/blank lines, strips quotes', () => {
    const parsed = parseEnvFile(
      ['# comment', '', 'OPENPROJECT_URL=https://op.test', 'OPENPROJECT_API_KEY="secret=with=equals"', "QUOTED='single'", 'NOEQ'].join('\n'),
    );
    expect(parsed).toEqual({
      OPENPROJECT_URL: 'https://op.test',
      OPENPROJECT_API_KEY: 'secret=with=equals',
      QUOTED: 'single',
    });
  });
});

describe('applyEnvFallback', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'op-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fills missing OPENPROJECT_* vars from an explicit OPENPROJECT_ENV_FILE', async () => {
    const envFile = path.join(dir, 'custom.env');
    await writeFile(envFile, 'OPENPROJECT_URL=https://from-file.test\nOPENPROJECT_API_KEY=filekey\nOTHER=x\n');
    const env: NodeJS.ProcessEnv = { OPENPROJECT_ENV_FILE: envFile };
    const res = applyEnvFallback(env);
    expect(res.loadedFrom).toBe(envFile);
    expect(res.appliedKeys.sort()).toEqual(['OPENPROJECT_API_KEY', 'OPENPROJECT_URL']);
    expect(env.OPENPROJECT_URL).toBe('https://from-file.test');
    expect(env.OPENPROJECT_API_KEY).toBe('filekey');
    // Non-OPENPROJECT_ keys are never applied.
    expect(env.OTHER).toBeUndefined();
  });

  it('never overrides values that are already set', async () => {
    const envFile = path.join(dir, '.env');
    await writeFile(envFile, 'OPENPROJECT_URL=https://from-file.test\nOPENPROJECT_API_KEY=filekey\n');
    const env: NodeJS.ProcessEnv = { OPENPROJECT_ENV_FILE: envFile, OPENPROJECT_URL: 'https://explicit.test' };
    applyEnvFallback(env);
    expect(env.OPENPROJECT_URL).toBe('https://explicit.test'); // kept
    expect(env.OPENPROJECT_API_KEY).toBe('filekey'); // filled
  });

  it('does nothing when required vars are already present', () => {
    const env: NodeJS.ProcessEnv = { OPENPROJECT_URL: 'https://x', OPENPROJECT_API_KEY: 'k' };
    const res = applyEnvFallback(env);
    expect(res.loadedFrom).toBeNull();
    expect(res.appliedKeys).toEqual([]);
  });
});

describe('maskValue', () => {
  it('shows only a 4-char prefix and the length', () => {
    expect(maskValue('opap1234567890')).toBe('opap… (len=14)');
    expect(maskValue(undefined)).toBe('<not set>');
  });
});
