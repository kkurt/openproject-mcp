import { describe, expect, it } from 'vitest';
import {
  assigneeIdFilter,
  closedStatusFilter,
  openStatusFilter,
  priorityIdFilter,
  searchFilter,
  serializeFilters,
  serializeSortBy,
  statusIdFilter,
  typeIdFilter,
  updatedAfterFilter,
} from '@openproject-agent/core';

describe('filter serialization', () => {
  it('serializes the spec example filter array', () => {
    const serialized = serializeFilters([openStatusFilter(), typeIdFilter(['1', '7'])]);
    expect(serialized).toBe(
      '[{"status":{"operator":"o","values":[]}},{"type":{"operator":"=","values":["1","7"]}}]',
    );
    // Round-trips as valid JSON.
    expect(JSON.parse(serialized)).toHaveLength(2);
  });

  it('builds each filter kind with the correct operator', () => {
    expect(closedStatusFilter()).toEqual({ status: { operator: 'c', values: [] } });
    expect(statusIdFilter(['3'])).toEqual({ status: { operator: '=', values: ['3'] } });
    expect(priorityIdFilter(['8'])).toEqual({ priority: { operator: '=', values: ['8'] } });
    expect(assigneeIdFilter(['5'])).toEqual({ assignee: { operator: '=', values: ['5'] } });
    expect(searchFilter('crash')).toEqual({ search: { operator: '**', values: ['crash'] } });
    expect(updatedAfterFilter('2024-01-01T00:00:00Z')).toEqual({
      updatedAt: { operator: '<>d', values: ['2024-01-01T00:00:00Z', ''] },
    });
  });

  it('serializes sortBy as JSON pairs', () => {
    expect(
      serializeSortBy([
        ['priority', 'desc'],
        ['id', 'asc'],
      ]),
    ).toBe('[["priority","desc"],["id","asc"]]');
  });
});
