/** Read-only MCP tools. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListWorkPackagesParams, SortBy } from '@openproject-agent/core';
import { z } from 'zod';
import { jsonResult, type ToolContext } from './context.js';

const sortItem = z.object({
  field: z.string().describe('Field to sort by, e.g. "priority", "id", "updatedAt".'),
  direction: z.enum(['asc', 'desc']),
});

/** Shared filter args reused by list_work_packages and get_next_work_package. */
const filterShape = {
  types: z.array(z.string()).optional().describe('Type names or ids, e.g. ["Bug","Feature"].'),
  statuses: z
    .array(z.string())
    .optional()
    .describe('Status names or ids. Special values "open"/"closed" supported. Default: open.'),
  assignee: z.string().optional().describe('"me", or a numeric user id.'),
  priority: z.array(z.string()).optional().describe('Priority names or ids.'),
  updatedAfter: z.string().optional().describe('ISO timestamp; only WPs updated on/after it.'),
  search: z.string().optional().describe('Full-text search over subject/description.'),
};

function toParams(args: {
  types?: string[];
  statuses?: string[];
  assignee?: string;
  priority?: string[];
  updatedAfter?: string;
  search?: string;
  sortBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
}): ListWorkPackagesParams {
  const params: ListWorkPackagesParams = {};
  if (args.types) params.types = args.types;
  if (args.statuses) params.statuses = args.statuses;
  if (args.assignee) params.assignee = args.assignee;
  if (args.priority) params.priority = args.priority;
  if (args.updatedAfter) params.updatedAfter = args.updatedAfter;
  if (args.search) params.search = args.search;
  if (args.sortBy?.length) params.sortBy = args.sortBy.map((s) => [s.field, s.direction]) as SortBy;
  return params;
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_projects',
    { title: 'List projects', description: 'List all OpenProject projects visible to the API user.' },
    async () => jsonResult(await ctx.client.listProjects()),
  );

  server.registerTool(
    'list_work_packages',
    {
      title: 'List work packages',
      description:
        'List work packages in a project with filtering and sorting. Returns compact summaries. ' +
        'Default sort: priority desc, then id asc. Default status filter: open.',
      inputSchema: {
        projectId: z.string().describe('Project id or identifier.'),
        ...filterShape,
        sortBy: z.array(sortItem).optional().describe('Sort order. Default: priority desc, id asc.'),
        limit: z.number().int().positive().max(200).optional().describe('Page size (default 50).'),
        offset: z.number().int().positive().optional().describe('1-based page offset (default 1).'),
      },
    },
    async (args) => {
      const params = toParams(args);
      if (args.limit) params.pageSize = args.limit;
      if (args.offset) params.offset = args.offset;
      const page = await ctx.client.listWorkPackages(args.projectId, params);
      return jsonResult({
        total: page.total,
        count: page.count,
        offset: page.offset,
        pageSize: page.pageSize,
        workPackages: page.elements,
      });
    },
  );

  server.registerTool(
    'get_work_package',
    {
      title: 'Get work package',
      description:
        'Full detail for one work package: raw description, type/status/priority/assignee, custom fields, ' +
        'comments (activities), relations (parent/child/blocks/relates), and attachment list.',
      inputSchema: { id: z.number().int().positive().describe('Work package id.') },
    },
    async ({ id }) => jsonResult(await ctx.client.getWorkPackage(id)),
  );

  server.registerTool(
    'get_next_work_package',
    {
      title: 'Get next work package',
      description:
        'Return the next work package to work on (same filter + default ordering as list_work_packages), ' +
        'skipping any ids passed in excludeIds. Returns { next: null } when nothing remains.',
      inputSchema: {
        projectId: z.string().describe('Project id or identifier.'),
        ...filterShape,
        excludeIds: z.array(z.number().int()).optional().describe('Work package ids to skip (already processed).'),
      },
    },
    async (args) => {
      const params = toParams(args);
      params.pageSize = 100;
      const page = await ctx.client.listWorkPackages(args.projectId, params);
      const exclude = new Set(args.excludeIds ?? []);
      const next = page.elements.find((wp) => !exclude.has(wp.id)) ?? null;
      return jsonResult({ next });
    },
  );

  server.registerTool(
    'list_statuses',
    { title: 'List statuses', description: 'List all statuses defined in the instance.' },
    async () => jsonResult(await ctx.client.listStatuses()),
  );

  server.registerTool(
    'list_types',
    { title: 'List types', description: 'List all work package types (Bug, Feature, Task, ...).' },
    async () => jsonResult(await ctx.client.listTypes()),
  );

  server.registerTool(
    'list_priorities',
    { title: 'List priorities', description: 'List all priorities.' },
    async () => jsonResult(await ctx.client.listPriorities()),
  );

  server.registerTool(
    'get_allowed_status_transitions',
    {
      title: 'Get allowed status transitions',
      description:
        'The status transitions OpenProject currently permits for a work package (discovered from its form). ' +
        'Use this instead of hard-coding status ids.',
      inputSchema: { workPackageId: z.number().int().positive().describe('Work package id.') },
    },
    async ({ workPackageId }) => jsonResult(await ctx.client.getAllowedStatusTransitions(workPackageId)),
  );
}
