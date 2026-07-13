/**
 * OpenProject query serialization: `filters` (JSON-encoded array) and `sortBy`
 * (JSON-encoded pairs). See spec §1.
 *
 * Example filters string:
 *   [{"status":{"operator":"o","values":[]}},{"type":{"operator":"=","values":["1","7"]}}]
 */

export type SortDirection = 'asc' | 'desc';
export type SortBy = Array<[field: string, direction: SortDirection]>;

/** A single filter: exactly one field name mapped to an operator + values. */
export type Filter = Record<string, { operator: string; values: string[] }>;

export function serializeFilters(filters: Filter[]): string {
  return JSON.stringify(filters);
}

export function serializeSortBy(sortBy: SortBy): string {
  return JSON.stringify(sortBy);
}

// --- common filter builders -------------------------------------------------

/** All open (not-closed) statuses. */
export function openStatusFilter(): Filter {
  return { status: { operator: 'o', values: [] } };
}

/** All closed statuses. */
export function closedStatusFilter(): Filter {
  return { status: { operator: 'c', values: [] } };
}

export function statusIdFilter(ids: string[]): Filter {
  return { status: { operator: '=', values: ids } };
}

export function typeIdFilter(ids: string[]): Filter {
  return { type: { operator: '=', values: ids } };
}

export function priorityIdFilter(ids: string[]): Filter {
  return { priority: { operator: '=', values: ids } };
}

export function assigneeIdFilter(ids: string[]): Filter {
  return { assignee: { operator: '=', values: ids } };
}

/** Work packages updated on/after the given ISO timestamp (open-ended upper bound). */
export function updatedAfterFilter(isoTimestamp: string): Filter {
  return { updatedAt: { operator: '<>d', values: [isoTimestamp, ''] } };
}

/** Full-text search across subject/description. */
export function searchFilter(text: string): Filter {
  return { search: { operator: '**', values: [text] } };
}
