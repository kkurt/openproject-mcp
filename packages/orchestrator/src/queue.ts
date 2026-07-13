/** Build the ordered queue of work packages to process, skipping already-processed ones. */
import type {
  ListWorkPackagesParams,
  OpenProjectClient,
  SortBy,
  WorkPackageSummaryDTO,
} from '@openproject-agent/core';
import type { AppConfig } from './config.js';
import type { StateStore } from './state.js';

export interface QueueOptions {
  /** Process exactly this work package (bypasses filters and state skip). */
  wp?: number;
  /** Override config.filters.types. */
  types?: string[];
  /** Cap the number of work packages. */
  limit?: number;
  /** Override the board name (enables board mode even without config.board). */
  board?: string;
  /** Override the board source column. */
  column?: string;
}

function pickSummary(wp: {
  id: number;
  type: string | null;
  subject: string;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  updatedAt: string | null;
  url: string;
}): WorkPackageSummaryDTO {
  return {
    id: wp.id,
    type: wp.type,
    subject: wp.subject,
    status: wp.status,
    priority: wp.priority,
    assignee: wp.assignee,
    updatedAt: wp.updatedAt,
    url: wp.url,
  };
}

export async function buildQueue(
  client: OpenProjectClient,
  config: AppConfig,
  state: StateStore,
  options: QueueOptions = {},
): Promise<WorkPackageSummaryDTO[]> {
  if (options.wp != null) {
    const detail = await client.getWorkPackage(options.wp);
    return [pickSummary(detail)];
  }

  const boardName = options.board ?? config.board?.name;
  if (boardName) {
    return buildBoardQueue(client, config, state, options, boardName);
  }

  const params: ListWorkPackagesParams = { sortBy: config.order as SortBy };
  if (options.types ?? config.filters.types) params.types = options.types ?? config.filters.types;
  if (config.filters.statuses) params.statuses = config.filters.statuses;
  if (config.filters.assignee) params.assignee = config.filters.assignee;
  if (config.filters.priority) params.priority = config.filters.priority;

  const all = await client.listAllWorkPackages(config.project, params);
  const pending = all.filter((wp) => !state.isProcessed(wp.id));
  return options.limit != null ? pending.slice(0, options.limit) : pending;
}

/** Board mode: pull cards from a board column (board order preserved via query_id),
 * then narrow client-side by type / assignee=me and skip processed. */
async function buildBoardQueue(
  client: OpenProjectClient,
  config: AppConfig,
  state: StateStore,
  options: QueueOptions,
  boardName: string,
): Promise<WorkPackageSummaryDTO[]> {
  const board = await client.getBoard(boardName, config.project);
  const columnName = options.column ?? config.board?.sourceColumn ?? board.columns[0]?.name;
  const column = columnName
    ? board.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase())
    : board.columns[0];
  if (!column) return [];

  let cards = await client.listAllBoardColumnWorkPackages(config.project, column.queryId);

  const types = options.types ?? config.filters.types;
  if (types?.length) {
    const set = new Set(types.map((t) => t.toLowerCase()));
    cards = cards.filter((c) => c.type != null && set.has(c.type.toLowerCase()));
  }
  if (config.filters.assignee === 'me') {
    const me = await client.getCurrentUser();
    cards = cards.filter((c) => c.assignee === me.name);
  }

  const pending = cards.filter((c) => !state.isProcessed(c.id));
  return options.limit != null ? pending.slice(0, options.limit) : pending;
}
