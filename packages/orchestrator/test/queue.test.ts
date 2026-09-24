import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenProjectClient, WorkPackageSummaryDTO } from '@openproject-agent/core';
import { StateStore, buildQueue, type AppConfig } from '@openproject-agent/orchestrator';

function summary(id: number, type = 'Bug', assignee: string | null = 'Me'): WorkPackageSummaryDTO {
  return { id, type, subject: `WP ${id}`, status: 'New', priority: 'High', assignee, updatedAt: null, url: 'u' };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    openproject: { url: 'https://op.test', apiKey: 'k' },
    project: 'demo',
    targetRepo: '/repo',
    filters: {},
    order: [['id', 'asc']],
    statusFlow: { start: 'In progress', success: 'Developed', blocked: 'On hold' },
    protectedTransitions: [],
    write: false,
    claude: { binPath: 'claude', maxTurns: 40, timeoutMs: 1000, allowedTools: [], disallowedTools: [], addDirs: [] },
    ...overrides,
  };
}

const board = {
  id: 18,
  name: 'Kanban',
  projectIdentifier: 'demo',
  columns: [
    { name: 'New', queryId: 55, statusId: 1, position: 1 },
    { name: 'In progress', queryId: 56, statusId: 7, position: 2 },
  ],
};

function boardClient(cards: WorkPackageSummaryDTO[]) {
  return {
    getBoard: vi.fn(async () => board),
    listAllBoardColumnWorkPackages: vi.fn(async () => cards),
    getCurrentUser: vi.fn(async () => ({ id: 9, name: 'Me', login: null, email: null })),
  } as unknown as OpenProjectClient;
}

let dir: string;
let state: StateStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'op-q-'));
  state = new StateStore(dir);
  await state.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildQueue board mode', () => {
  it('pulls the leftmost column, preserving board order', async () => {
    const client = boardClient([summary(287), summary(288)]);
    const queue = await buildQueue(client, makeConfig({ board: { name: 'Kanban' } }), state, {});
    expect(queue.map((w) => w.id)).toEqual([287, 288]);
    expect(client.getBoard).toHaveBeenCalledWith('Kanban', 'demo');
    expect(client.listAllBoardColumnWorkPackages).toHaveBeenCalledWith('demo', 55);
  });

  it('honors --board / --column overrides', async () => {
    const client = boardClient([summary(1)]);
    await buildQueue(client, makeConfig(), state, { board: 'Kanban', column: 'In progress' });
    expect(client.listAllBoardColumnWorkPackages).toHaveBeenCalledWith('demo', 56);
  });

  it('narrows by type and assignee=me, and skips processed cards', async () => {
    await state.set(287, { status: 'done' });
    const client = boardClient([
      summary(287, 'Bug', 'Me'),
      summary(288, 'Feature', 'Me'),
      summary(289, 'Bug', 'Someone Else'),
      summary(290, 'Bug', 'Me'),
    ]);
    const config = makeConfig({ board: { name: 'Kanban' }, filters: { types: ['Bug'], assignee: 'me' } });
    const queue = await buildQueue(client, config, state, {});
    // 287 processed, 288 not a Bug, 289 not me -> only 290 remains
    expect(queue.map((w) => w.id)).toEqual([290]);
  });
});
