/** Board (Grid) read tools. Boards are status-based Kanban boards; columns are saved queries. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, type ToolContext } from './context.js';

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description:
        'List boards (optionally restricted to one project). Each board has ordered columns ' +
        '(name + status + queryId). Board names are unique only within a project.',
      inputSchema: { projectId: z.string().optional().describe('Restrict to a project id/identifier.') },
    },
    async ({ projectId }) => jsonResult(await ctx.client.listBoards(projectId)),
  );

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description: 'Get one board by name within a project, including its ordered columns.',
      inputSchema: {
        projectId: z.string().describe('Project id/identifier.'),
        name: z.string().describe('Board name.'),
      },
    },
    async ({ projectId, name }) => jsonResult(await ctx.client.getBoard(name, projectId)),
  );

  server.registerTool(
    'list_board_column',
    {
      title: 'List board column cards',
      description: 'List the work packages in a named board column, in board order.',
      inputSchema: {
        projectId: z.string(),
        boardName: z.string(),
        columnName: z.string().describe('Column (status) name, e.g. "New".'),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().positive().optional(),
      },
    },
    async ({ projectId, boardName, columnName, limit, offset }) => {
      const board = await ctx.client.getBoard(boardName, projectId);
      const column = board.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
      if (!column) {
        return errorResult(
          `Board '${boardName}' has no column '${columnName}'. Columns: ${board.columns.map((c) => c.name).join(', ')}.`,
        );
      }
      const page = await ctx.client.listBoardColumnWorkPackages(projectId, column.queryId, {
        pageSize: limit ?? 50,
        offset: offset ?? 1,
      });
      return jsonResult({ board: board.name, column: column.name, total: page.total, workPackages: page.elements });
    },
  );

  server.registerTool(
    'get_next_board_card',
    {
      title: 'Get next board card',
      description: 'Return the next card in a board column, skipping excludeIds. Returns { next: null } when none remain.',
      inputSchema: {
        projectId: z.string(),
        boardName: z.string(),
        columnName: z.string(),
        excludeIds: z.array(z.number().int()).optional(),
      },
    },
    async ({ projectId, boardName, columnName, excludeIds }) => {
      const board = await ctx.client.getBoard(boardName, projectId);
      const column = board.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
      if (!column) return errorResult(`Board '${boardName}' has no column '${columnName}'.`);
      const page = await ctx.client.listBoardColumnWorkPackages(projectId, column.queryId, { pageSize: 100 });
      const exclude = new Set(excludeIds ?? []);
      return jsonResult({ next: page.elements.find((c) => !exclude.has(c.id)) ?? null });
    },
  );
}
