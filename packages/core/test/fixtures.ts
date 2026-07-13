/** HAL+JSON fixtures shared across core tests. */

export function halCollection<T>(
  elements: T[],
  opts: { total?: number; count?: number; pageSize?: number; offset?: number } = {},
): unknown {
  return {
    _type: 'Collection',
    total: opts.total ?? elements.length,
    count: opts.count ?? elements.length,
    pageSize: opts.pageSize ?? elements.length,
    offset: opts.offset ?? 1,
    _embedded: { elements },
  };
}

export function workPackageHal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { _links: linkOverrides, ...rest } = overrides as { _links?: Record<string, unknown> };
  return {
    _type: 'WorkPackage',
    id: 42,
    subject: 'Fix the login crash',
    description: { format: 'markdown', raw: 'Steps to reproduce...', html: '<p>Steps</p>' },
    lockVersion: 3,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    startDate: null,
    dueDate: null,
    estimatedHours: null,
    _links: {
      self: { href: '/api/v3/work_packages/42' },
      type: { href: '/api/v3/types/1', title: 'Bug' },
      status: { href: '/api/v3/statuses/1', title: 'New' },
      priority: { href: '/api/v3/priorities/8', title: 'High' },
      assignee: { href: '/api/v3/users/5', title: 'Alice' },
      author: { href: '/api/v3/users/1', title: 'Bob' },
      project: { href: '/api/v3/projects/3', title: 'Demo Project' },
      parent: { href: '/api/v3/work_packages/40', title: 'Epic: Auth' },
      ...linkOverrides,
    },
    ...rest,
  };
}

export function statusHal(id: number, name: string, isClosed = false): Record<string, unknown> {
  return {
    _type: 'Status',
    id,
    name,
    isClosed,
    _links: { self: { href: `/api/v3/statuses/${id}`, title: name } },
  };
}

export function typeHal(id: number, name: string): Record<string, unknown> {
  return { _type: 'Type', id, name, _links: { self: { href: `/api/v3/types/${id}`, title: name } } };
}

export function priorityHal(id: number, name: string): Record<string, unknown> {
  return { _type: 'Priority', id, name, _links: { self: { href: `/api/v3/priorities/${id}`, title: name } } };
}

export function activityHal(id: number, raw: string, user = 'Alice'): Record<string, unknown> {
  return {
    _type: 'Activity::Comment',
    id,
    comment: { format: 'markdown', raw, html: `<p>${raw}</p>` },
    createdAt: '2024-01-03T00:00:00Z',
    _links: { user: { href: '/api/v3/users/5', title: user } },
  };
}

/** A form response whose status schema exposes the given allowed transitions. */
export function formHal(allowed: Array<{ id: number; name: string }>): Record<string, unknown> {
  return {
    _type: 'Form',
    _embedded: {
      schema: {
        status: {
          type: 'Status',
          _embedded: {
            allowedValues: allowed.map((s) => statusHal(s.id, s.name)),
          },
        },
      },
      payload: {},
      validationErrors: {},
    },
  };
}
