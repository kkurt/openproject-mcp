/**
 * Write agent results back to OpenProject: a review comment plus a status
 * advance per config.statusFlow. All writes are gated by dryRun and never touch
 * protected transitions. In dry-run mode NO OpenProject write call is made.
 */
import type { OpenProjectClient, WorkPackageDetailDTO } from '@openproject-agent/core';
import { maskSecret, type AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { AgentReport } from './report.js';

/** Default for config.commentFooter. */
const AI_NOTE = '_This change was produced by an AI agent and must be reviewed by a human._';

export function isProtected(config: AppConfig, statusName: string): boolean {
  return config.protectedTransitions.some((p) => p.toLowerCase() === statusName.toLowerCase());
}

export function buildResultComment(report: AgentReport, footer: string = AI_NOTE): string {
  const lines: string[] = [];
  lines.push(`## AI Agent Result: ${report.result}`);
  lines.push('');
  lines.push(report.summary.trim() || '_(no summary reported)_');
  lines.push('');
  lines.push('**Changed files:**');
  lines.push(report.changedFiles.length ? report.changedFiles.map((f) => `- ${f}`).join('\n') : '_none reported_');
  if (report.openQuestions.length) {
    lines.push('');
    lines.push('**Open questions:**');
    lines.push(report.openQuestions.map((q) => `- ${q}`).join('\n'));
  }
  lines.push('');
  lines.push(`**Tests:** ${report.testsRun.trim() || '_not reported_'}`);
  if (footer.trim()) {
    lines.push('');
    lines.push('---');
    lines.push(footer.trim());
  }
  return lines.join('\n');
}

export interface ActionContext {
  dryRun: boolean;
  logger: Logger;
}

/** Apply a status transition, honoring dry-run and protected transitions. Returns the new status name or null. */
export async function applyStatus(
  client: OpenProjectClient,
  config: AppConfig,
  wpId: number,
  statusName: string,
  ctx: ActionContext,
): Promise<string | null> {
  if (isProtected(config, statusName)) {
    ctx.logger.warn(`Skipping PROTECTED transition to '${statusName}' for WP ${wpId} (requires human approval).`);
    return null;
  }
  if (ctx.dryRun) {
    ctx.logger.info(`[dry-run] would set WP ${wpId} status -> '${statusName}'`);
    return null;
  }
  try {
    await client.updateStatus(wpId, statusName);
    return statusName;
  } catch (err) {
    ctx.logger.warn(`Could not transition WP ${wpId} to '${statusName}': ${(err as Error).message}`);
    return null;
  }
}

/** Move a work package to the configured start status at the beginning of processing. */
export async function markStart(
  client: OpenProjectClient,
  config: AppConfig,
  wp: WorkPackageDetailDTO,
  ctx: ActionContext,
): Promise<string | null> {
  const target = config.statusFlow.start;
  if (wp.status && wp.status.toLowerCase() === target.toLowerCase()) return null;
  return applyStatus(client, config, wp.id, target, ctx);
}

export interface FinalizeResult {
  commented: boolean;
  statusChanged: string | null;
}

/** Post the review comment and advance status based on the agent's result. */
export async function finalize(
  client: OpenProjectClient,
  config: AppConfig,
  wp: WorkPackageDetailDTO,
  report: AgentReport,
  ctx: ActionContext,
): Promise<FinalizeResult> {
  const result: FinalizeResult = { commented: false, statusChanged: null };

  // The report is agent-written text that becomes visible to everyone in the project.
  const comment = maskSecret(buildResultComment(report, config.commentFooter), config.openproject.apiKey);
  if (ctx.dryRun) {
    ctx.logger.info(`[dry-run] would comment on WP ${wp.id} (${comment.length} chars)`);
  } else {
    await client.addComment(wp.id, comment);
    result.commented = true;
  }

  let targetStatus: string | null = null;
  if (report.result === 'done') targetStatus = config.statusFlow.success;
  else if (report.result === 'blocked' || report.result === 'failed') targetStatus = config.statusFlow.blocked;
  // 'unknown' -> no auto-advance; needs human review.

  if (targetStatus) {
    result.statusChanged = await applyStatus(client, config, wp.id, targetStatus, ctx);
  } else {
    ctx.logger.info(`WP ${wp.id}: result '${report.result}' -> no automatic status change (human review).`);
  }
  return result;
}
