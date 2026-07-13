/** Write MCP tools. Every tool honors `dryRun` and the global read-only mode. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, isProtectedTransition, jsonResult, type ToolContext } from './context.js';

const READ_ONLY_MSG = 'Server is in read-only mode; this write was refused. Re-run with dryRun to preview instead.';

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: 'Add a markdown comment (activity) to a work package.',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        markdown: z.string().min(1).describe('Comment body in markdown.'),
        dryRun: z.boolean().optional().describe('If true, do not write — just preview.'),
      },
    },
    async ({ workPackageId, markdown, dryRun }) => {
      if (dryRun) return jsonResult({ dryRun: true, action: 'add_comment', workPackageId, markdown });
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      return jsonResult({ ok: true, comment: await ctx.client.addComment(workPackageId, markdown) });
    },
  );

  server.registerTool(
    'update_work_package_status',
    {
      title: 'Update work package status',
      description:
        'Transition a work package to a new status (by name or id). Verifies the transition is permitted, ' +
        'and refuses PROTECTED transitions (e.g. Closed/Rejected) which require human approval.',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        status: z.string().describe('Target status name or id.'),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workPackageId, status, dryRun }) => {
      const statuses = await ctx.client.listStatuses();
      const target = /^\d+$/.test(status)
        ? statuses.find((s) => s.id === Number(status))
        : statuses.find((s) => s.name.toLowerCase() === status.toLowerCase());
      const targetName = target?.name ?? status;

      if (isProtectedTransition(ctx.protectedTransitions, targetName)) {
        return errorResult(
          `Refusing to transition WP ${workPackageId} to '${targetName}': this is a PROTECTED transition that ` +
            `requires human approval. (Protected: ${ctx.protectedTransitions.join(', ')}.)`,
        );
      }

      const allowed = await ctx.client.getAllowedStatusTransitions(workPackageId);
      const permitted = allowed.some((a) =>
        target ? a.id === target.id : a.name.toLowerCase() === targetName.toLowerCase(),
      );
      if (allowed.length > 0 && !permitted) {
        return errorResult(
          `Transition to '${targetName}' is not allowed for WP ${workPackageId}. ` +
            `Allowed: ${allowed.map((a) => a.name).join(', ') || '(none)'}.`,
        );
      }

      if (dryRun) {
        return jsonResult({ dryRun: true, action: 'update_status', workPackageId, wouldTransitionTo: targetName, allowedTransitions: allowed });
      }
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      return jsonResult({ ok: true, workPackage: await ctx.client.updateStatus(workPackageId, status) });
    },
  );

  server.registerTool(
    'assign_work_package',
    {
      title: 'Assign work package',
      description: 'Assign a work package to a user ("me" or a numeric user id).',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        assignee: z.string().describe('"me" or a numeric user id.'),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workPackageId, assignee, dryRun }) => {
      if (dryRun) return jsonResult({ dryRun: true, action: 'assign', workPackageId, assignee });
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      return jsonResult({ ok: true, workPackage: await ctx.client.assign(workPackageId, assignee) });
    },
  );

  server.registerTool(
    'log_time',
    {
      title: 'Log time',
      description: 'Log spent time (hours) against a work package. Optional comment.',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        hours: z.number().positive().describe('Hours spent (decimal allowed, e.g. 1.5).'),
        comment: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workPackageId, hours, comment, dryRun }) => {
      if (dryRun) return jsonResult({ dryRun: true, action: 'log_time', workPackageId, hours, comment });
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      await ctx.client.logTime(workPackageId, hours, comment);
      return jsonResult({ ok: true, workPackageId, hours, comment });
    },
  );
}
