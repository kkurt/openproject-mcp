import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenProjectClient, WorkPackageDetailDTO, WorkPackageSummaryDTO } from '@openproject-agent/core';
import {
  StateStore,
  createLogger,
  runOrchestrator,
  type AppConfig,
  type RunAgent,
  type RunDeps,
} from '@openproject-agent/orchestrator';

const silentLogger = createLogger({ sink: () => {} });

function summary(id: number): WorkPackageSummaryDTO {
  return {
    id,
    type: 'Bug',
    subject: `WP ${id}`,
    status: 'New',
    priority: 'High',
    assignee: null,
    updatedAt: null,
    url: `https://op.test/work_packages/${id}`,
  };
}

function detail(id: number): WorkPackageDetailDTO {
  return {
    ...summary(id),
    description: 'do the thing',
    project: null,
    author: null,
    createdAt: null,
    startDate: null,
    dueDate: null,
    estimatedHours: null,
    lockVersion: 1,
    customFields: {},
    comments: [],
    relations: [],
    attachments: [],
  };
}

function makeClient(summaries: WorkPackageSummaryDTO[]) {
  return {
    listAllWorkPackages: vi.fn(async () => summaries),
    getWorkPackage: vi.fn(async (id: number) => detail(id)),
    addComment: vi.fn(async () => ({ id: 1, author: 'me', comment: '', createdAt: null })),
    updateStatus: vi.fn(async (id: number) => summary(id)),
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    openproject: { url: 'https://op.test', apiKey: 'k' },
    project: 'demo',
    targetRepo: '/repo',
    filters: {},
    order: [['id', 'asc']],
    statusFlow: { start: 'In progress', success: 'Developed', blocked: 'On hold' },
    protectedTransitions: ['Closed', 'Rejected'],
    write: false,
    claude: { binPath: 'claude', maxTurns: 40, timeoutMs: 1000, allowedTools: [], disallowedTools: [], addDirs: [] },
    ...overrides,
  };
}

function agentReturning(finalText: string): RunAgent {
  return vi.fn(async () => ({ finalText, turns: 1, exitCode: 0, lineCount: 1 }));
}

let dir: string;
let state: StateStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'op-orch-'));
  state = new StateStore(dir);
  await state.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(client: ReturnType<typeof makeClient>, config: AppConfig, runAgent: RunAgent): RunDeps {
  return {
    client: client as unknown as OpenProjectClient,
    config,
    state,
    logger: silentLogger,
    promptTemplate: 'WP {{id}}: {{subject}}',
    runAgent,
    now: () => 'T',
  };
}

describe('runOrchestrator', () => {
  it('dry-run runs the agent but performs zero OpenProject writes', async () => {
    const client = makeClient([summary(42)]);
    const runAgent = agentReturning('{"result":"done","summary":"ok","changedFiles":["a.ts"]}');
    const result = await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: true, yes: true });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(client.addComment).not.toHaveBeenCalled();
    expect(client.updateStatus).not.toHaveBeenCalled();
    expect(result.done).toBe(1);
    expect(state.get(42)?.status).toBe('done');
    expect(state.get(42)?.changedFiles).toEqual(['a.ts']);
  });

  it('write mode comments and advances New -> In progress -> Developed', async () => {
    const client = makeClient([summary(42)]);
    const runAgent = agentReturning('{"result":"done","summary":"fixed it"}');
    await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: false, yes: true });

    expect(client.addComment).toHaveBeenCalledTimes(1);
    expect(client.addComment.mock.calls[0]?.[1]).toContain('AI Agent Result: done');
    const statuses = client.updateStatus.mock.calls.map((c) => c[1]);
    expect(statuses).toContain('In progress');
    expect(statuses).toContain('Developed');
    expect(state.get(42)?.status).toBe('done');
  });

  it('ends the result comment with the default English AI footer', async () => {
    const client = makeClient([summary(42)]);
    await runOrchestrator(deps(client, makeConfig(), agentReturning('{"result":"done"}')), { dryRun: false, yes: true });

    expect(client.addComment.mock.calls[0]?.[1]).toMatch(/\n---\n_This change was produced by an AI agent.*_$/);
  });

  it('uses the configured commentFooter, and omits the footer when it is empty', async () => {
    const custom = makeClient([summary(42)]);
    const runAgent = agentReturning('{"result":"done"}');
    await runOrchestrator(deps(custom, makeConfig({ commentFooter: '_custom note_' }), runAgent), {
      dryRun: false,
      yes: true,
    });
    expect(custom.addComment.mock.calls[0]?.[1]).toMatch(/\n---\n_custom note_$/);

    const none = makeClient([summary(43)]);
    await runOrchestrator(deps(none, makeConfig({ commentFooter: '' }), runAgent), { dryRun: false, yes: true });
    expect(none.addComment.mock.calls[0]?.[1]).not.toContain('---');
  });

  it('blocked result advances to the blocked status', async () => {
    const client = makeClient([summary(42)]);
    const runAgent = agentReturning('{"result":"blocked","summary":"stuck","openQuestions":["which db?"]}');
    await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: false, yes: true });

    expect(client.updateStatus.mock.calls.map((c) => c[1])).toContain('On hold');
    expect(state.get(42)?.status).toBe('blocked');
  });

  it('unknown result routes to needs_review with a comment but no success/blocked transition', async () => {
    const client = makeClient([summary(42)]);
    const runAgent = agentReturning('no structured block here');
    await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: false, yes: true });

    expect(client.addComment).toHaveBeenCalledTimes(1);
    const statuses = client.updateStatus.mock.calls.map((c) => c[1]);
    expect(statuses).toContain('In progress'); // markStart
    expect(statuses).not.toContain('Developed');
    expect(statuses).not.toContain('On hold');
    expect(state.get(42)?.status).toBe('needs_review');
  });

  it('never performs a protected transition even if configured as success', async () => {
    const client = makeClient([summary(42)]);
    const config = makeConfig({ statusFlow: { start: 'In progress', success: 'Closed', blocked: 'On hold' } });
    const runAgent = agentReturning('{"result":"done","summary":"x"}');
    await runOrchestrator(deps(client, config, runAgent), { dryRun: false, yes: true });

    expect(client.updateStatus.mock.calls.map((c) => c[1])).not.toContain('Closed');
  });

  it('skips already-processed work packages (idempotent resume)', async () => {
    await state.set(42, { status: 'done' });
    const client = makeClient([summary(42), summary(43)]);
    const runAgent = agentReturning('{"result":"done"}');
    const result = await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: true, yes: true });

    expect(result.queued).toBe(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(client.getWorkPackage).toHaveBeenCalledWith(43);
  });

  it('honors confirm decisions (skip / process / quit)', async () => {
    const client = makeClient([summary(42), summary(43), summary(44)]);
    const runAgent = agentReturning('{"result":"done"}');
    const decisions: Record<number, 'skip' | 'process' | 'quit'> = { 42: 'skip', 43: 'process', 44: 'quit' };
    const confirm = vi.fn(async (id: number) => decisions[id]!);
    const result = await runOrchestrator(
      { ...deps(client, makeConfig(), runAgent), confirm },
      { dryRun: true, yes: false },
    );

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.stopped).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('records a failed status when the agent run throws', async () => {
    const client = makeClient([summary(42)]);
    const runAgent = vi.fn(async () => {
      throw new Error('claude crashed');
    });
    const result = await runOrchestrator(deps(client, makeConfig(), runAgent), { dryRun: true, yes: true });

    expect(result.failed).toBe(1);
    expect(state.get(42)?.status).toBe('failed');
    expect(state.get(42)?.error).toContain('claude crashed');
  });
});
