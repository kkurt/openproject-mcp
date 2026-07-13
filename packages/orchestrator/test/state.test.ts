import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '@openproject-agent/orchestrator';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'op-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('persists and reloads across instances', async () => {
    const s = new StateStore(dir);
    await s.load();
    await s.set(42, { status: 'done', result: 'done', finishedAt: 't' });

    const s2 = new StateStore(dir);
    await s2.load();
    expect(s2.get(42)?.status).toBe('done');
  });

  it('treats only terminal statuses as processed', async () => {
    const s = new StateStore(dir);
    await s.load();
    await s.set(1, { status: 'in_progress' });
    await s.set(2, { status: 'done' });
    await s.set(3, { status: 'needs_review' });
    expect(s.isProcessed(1)).toBe(false);
    expect(s.isProcessed(2)).toBe(true);
    expect(s.isProcessed(3)).toBe(true);
    expect(s.isProcessed(999)).toBe(false);
  });

  it('merges successive patches', async () => {
    const s = new StateStore(dir);
    await s.load();
    await s.set(1, { status: 'in_progress', startedAt: 'a' });
    await s.set(1, { status: 'done', finishedAt: 'b' });
    expect(s.get(1)).toMatchObject({ status: 'done', startedAt: 'a', finishedAt: 'b' });
  });

  it('clears state', async () => {
    const s = new StateStore(dir);
    await s.load();
    await s.set(1, { status: 'done' });
    await s.clear();
    expect(Object.keys(s.all().workPackages)).toHaveLength(0);
  });

  it('tolerates a missing/corrupt state file', async () => {
    const s = new StateStore(path.join(dir, 'does-not-exist-yet'));
    await s.load();
    expect(s.all().workPackages).toEqual({});
  });
});
