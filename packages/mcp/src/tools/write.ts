/** Write MCP tools. Every tool honors `dryRun` and the global read-only mode. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkPackageChanges } from '@openproject-agent/core';
import { z } from 'zod';
import { errorResult, isProtectedTransition, jsonResult, type ToolContext } from './context.js';

const READ_ONLY_MSG = 'Server is in read-only mode; this write was refused. Re-run with dryRun to preview instead.';

/** update_work_package inputs that shape the edit rather than name a field to change. */
const EDIT_OPTION_KEYS = new Set(['descriptionMode', 'lockVersion']);

const CHANGE_TEXT_LIMIT = 600;

/** Keep the head and tail of long text so a diff stays readable (an append lands at the end). */
function elide(text: string): string {
  if (text.length <= CHANGE_TEXT_LIMIT) return text;
  const half = CHANGE_TEXT_LIMIT / 2;
  return `${text.slice(0, half)}\n… [${text.length - CHANGE_TEXT_LIMIT} chars omitted] …\n${text.slice(-half)}`;
}

function compactChanges(changes: WorkPackageChanges): WorkPackageChanges {
  const { description } = changes;
  if (!description) return changes;
  return { ...changes, description: { from: elide(description.from), to: elide(description.to) } };
}

/** Shared status-transition logic: resolve target, block protected/disallowed, honor dryRun/read-only. */
async function transitionStatus(
  ctx: ToolContext,
  workPackageId: number,
  status: string,
  dryRun: boolean | undefined,
): Promise<CallToolResult> {
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
}

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
    async ({ workPackageId, status, dryRun }) => transitionStatus(ctx, workPackageId, status, dryRun),
  );

  server.registerTool(
    'start_work_package',
    {
      title: 'Start work package',
      description:
        `Mark a work package as started by moving it to the "${ctx.startStatus}" status. ` +
        'Call this as soon as you begin working on a work package. Honors dryRun and refuses protected transitions.',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workPackageId, dryRun }) => transitionStatus(ctx, workPackageId, ctx.startStatus, dryRun),
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
    'create_work_package',
    {
      title: 'Create work package',
      description:
        'Create a new work package (e.g. capture a requirement or bug from a conversation). ' +
        'Resolves type/priority names and "me" as assignee. Honors dryRun and global read-only mode.',
      inputSchema: {
        projectId: z.string().describe('Project id or identifier.'),
        type: z.string().describe('Type name or id, e.g. "Bug", "Feature", "Task".'),
        subject: z.string().min(1),
        description: z.string().optional().describe('Markdown description.'),
        assignee: z.string().optional().describe('"me" or a numeric user id.'),
        priority: z.string().optional().describe('Priority name or id.'),
        parentId: z.number().int().positive().optional().describe('Parent work package id.'),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ projectId, type, subject, description, assignee, priority, parentId, dryRun }) => {
      if (dryRun) {
        return jsonResult({ dryRun: true, action: 'create_work_package', projectId, type, subject, description, assignee, priority, parentId });
      }
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      const created = await ctx.client.createWorkPackage(projectId, {
        type,
        subject,
        ...(description ? { description } : {}),
        ...(assignee ? { assignee } : {}),
        ...(priority ? { priority } : {}),
        ...(parentId != null ? { parentId } : {}),
      });
      return jsonResult({ ok: true, workPackage: created });
    },
  );

  server.registerTool(
    'update_work_package',
    {
      title: 'Update work package',
      description:
        'Edit fields of a work package: subject, description (replace or append), start/due date, estimate, ' +
        '% done, priority, assignee, accountable, parent. Only the fields you pass change; null clears a field. ' +
        'Status is NOT changed here (use update_work_package_status). When replacing the description, pass the ' +
        'lockVersion from get_work_package so a concurrent human edit is reported instead of overwritten. ' +
        'dryRun returns the before/after of each field without writing.',
      inputSchema: {
        workPackageId: z.number().int().positive(),
        subject: z.string().min(1).optional(),
        description: z.string().optional().describe('Markdown description. "" clears it.'),
        descriptionMode: z
          .enum(['replace', 'append'])
          .optional()
          .describe('replace (default) overwrites the description; append adds the text after it.'),
        startDate: z.iso.date().nullable().optional().describe('YYYY-MM-DD, or null to clear.'),
        dueDate: z.iso.date().nullable().optional().describe('YYYY-MM-DD, or null to clear.'),
        estimatedHours: z.number().min(0).nullable().optional().describe('Estimated hours (decimal allowed).'),
        percentageDone: z.number().int().min(0).max(100).nullable().optional(),
        priority: z.string().optional().describe('Priority name or id.'),
        assignee: z.string().nullable().optional().describe('"me", a numeric user id, or null to unassign.'),
        responsible: z
          .string()
          .nullable()
          .optional()
          .describe('Accountable user: "me", a numeric user id, or null to clear.'),
        parentId: z.number().int().positive().nullable().optional().describe('Parent work package id, or null to detach.'),
        lockVersion: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('lockVersion from the get_work_package this edit is based on; refuses the edit if it changed since.'),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workPackageId, dryRun, ...params }) => {
      if (!Object.entries(params).some(([key, value]) => value !== undefined && !EDIT_OPTION_KEYS.has(key))) {
        return errorResult(
          'Nothing to update: pass at least one field (subject, description, dates, ...). ' +
            'Status changes go through update_work_package_status.',
        );
      }
      if (dryRun) {
        const preview = await ctx.client.previewWorkPackageEdit(workPackageId, params);
        return jsonResult({ dryRun: true, action: 'update_work_package', ...preview, changes: compactChanges(preview.changes) });
      }
      if (ctx.readOnly) return errorResult(READ_ONLY_MSG);
      const result = await ctx.client.editWorkPackage(workPackageId, params);
      return jsonResult({ ok: true, ...result, changes: compactChanges(result.changes) });
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
