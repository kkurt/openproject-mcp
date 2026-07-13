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

  const params: ListWorkPackagesParams = { sortBy: config.order as SortBy };
  if (options.types ?? config.filters.types) params.types = options.types ?? config.filters.types;
  if (config.filters.statuses) params.statuses = config.filters.statuses;
  if (config.filters.assignee) params.assignee = config.filters.assignee;
  if (config.filters.priority) params.priority = config.filters.priority;

  const all = await client.listAllWorkPackages(config.project, params);
  const pending = all.filter((wp) => !state.isProcessed(wp.id));
  return options.limit != null ? pending.slice(0, options.limit) : pending;
}
