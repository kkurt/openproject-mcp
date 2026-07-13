/**
 * Sequential run loop (concurrency = 1): for each queued work package, fetch
 * detail, run the agent, parse its report, and (in write mode) comment + advance
 * status. State is persisted after every step so runs are resumable.
 */
import type { OpenProjectClient, WorkPackageDetailDTO } from '@openproject-agent/core';
import { finalize, markStart } from './actions.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { renderWorkPackagePrompt } from './prompt.js';
import { buildQueue, type QueueOptions } from './queue.js';
import { parseReport } from './report.js';
import type { RunnerResult } from './runner.js';
import type { StateStore, WorkPackageStatus } from './state.js';

export type RunAgent = (args: {
  wp: WorkPackageDetailDTO;
  prompt: string;
  dryRun: boolean;
}) => Promise<RunnerResult>;

export type ConfirmDecision = 'process' | 'skip' | 'quit';

export interface RunDeps {
  client: OpenProjectClient;
  config: AppConfig;
  state: StateStore;
  logger: Logger;
  promptTemplate: string;
  runAgent: RunAgent;
  /** Interactive per-WP gate; omit for non-interactive (always processes). */
  confirm?: (wp: WorkPackageDetailDTO['id'], subject: string) => Promise<ConfirmDecision>;
  /** ISO timestamp provider (injectable for tests). */
  now?: () => string;
}

export interface RunOptions extends QueueOptions {
  dryRun: boolean;
  yes: boolean;
}

export interface RunSummary {
  queued: number;
  processed: number;
  done: number;
  blocked: number;
  failed: number;
  needsReview: number;
  skipped: number;
  stopped: boolean;
}

function terminalStatus(result: string): WorkPackageStatus {
  if (result === 'done') return 'done';
  if (result === 'blocked') return 'blocked';
  if (result === 'failed') return 'failed';
  return 'needs_review';
}

export async function runOrchestrator(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { client, config, state, logger, promptTemplate, runAgent } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const queue = await buildQueue(client, config, state, options);
  const summary: RunSummary = {
    queued: queue.length,
    processed: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    needsReview: 0,
    skipped: 0,
    stopped: false,
  };
  logger.info(`Queue: ${queue.length} work package(s)${options.dryRun ? ' (dry-run)' : ' (WRITE mode)'}`);

  for (const item of queue) {
    if (!options.yes && deps.confirm) {
      const decision = await deps.confirm(item.id, item.subject);
      if (decision === 'quit') {
        logger.info('Stopped by user.');
        summary.stopped = true;
        break;
      }
      if (decision === 'skip') {
        summary.skipped += 1;
        logger.info(`Skipped WP ${item.id}.`);
        continue;
      }
    }

    logger.info(`\n=== WP ${item.id} [${item.type ?? '?'}] ${item.subject} ===`);
    const wp = await client.getWorkPackage(item.id);
    await state.set(wp.id, { status: 'in_progress', startedAt: now() });
    await markStart(client, config, wp, { dryRun: options.dryRun, logger });

    const prompt = renderWorkPackagePrompt(promptTemplate, wp, { targetRepo: config.targetRepo });

    let runnerResult: RunnerResult;
    try {
      runnerResult = await runAgent({ wp, prompt, dryRun: options.dryRun });
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Agent run failed for WP ${wp.id}: ${message}`);
      await state.set(wp.id, { status: 'failed', finishedAt: now(), error: message });
      summary.failed += 1;
      summary.processed += 1;
      continue;
    }

    const report = parseReport(runnerResult.finalText);
    if (runnerResult.killedReason) {
      logger.warn(`Agent for WP ${wp.id} was terminated (${runnerResult.killedReason}).`);
    }

    await finalize(client, config, wp, report, { dryRun: options.dryRun, logger });

    const status = terminalStatus(report.result);
    const errorNote =
      runnerResult.killedReason
        ? `terminated: ${runnerResult.killedReason}`
        : report.result === 'unknown'
          ? 'no structured result block; needs human review'
          : undefined;
    await state.set(wp.id, {
      status,
      finishedAt: now(),
      sessionId: runnerResult.sessionId,
      changedFiles: report.changedFiles,
      result: report.result,
      ...(errorNote ? { error: errorNote } : {}),
    });

    summary.processed += 1;
    if (status === 'done') summary.done += 1;
    else if (status === 'blocked') summary.blocked += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.needsReview += 1;

    logger.info(`WP ${wp.id} -> ${report.result}${runnerResult.killedReason ? ` (${runnerResult.killedReason})` : ''}`);
  }

  return summary;
}
