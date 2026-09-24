import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NotFoundError, OpenProjectClient, UnprocessableError } from '@openproject-agent/core';
import {
  activityHal,
  formHal,
  halCollection,
  statusHal,
  typeHal,
  workPackageHal,
} from './fixtures.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://op.test';
const makeClient = (): OpenProjectClient => new OpenProjectClient({ url: BASE, apiKey: 'secret', timeoutMs: 0 });

describe('pagination', () => {
  it('walks all pages, offset starting at 1', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => workPackageHal({ id: i + 1, subject: `WP ${i + 1}` }));
    const page2 = Array.from({ length: 5 }, (_, i) => workPackageHal({ id: i + 21, subject: `WP ${i + 21}` }));
    const seenOffsets: number[] = [];
    server.use(
      http.get(`${BASE}/api/v3/projects/:pid/work_packages`, ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get('offset'));
        seenOffsets.push(offset);
        return HttpResponse.json(
          offset === 1
            ? halCollection(page1, { total: 25, count: 20, pageSize: 20, offset: 1 })
            : halCollection(page2, { total: 25, count: 5, pageSize: 20, offset: 2 }),
        );
      }),
    );
    const all = await makeClient().listAllWorkPackages('demo', { statuses: ['open'] });
    expect(all).toHaveLength(25);
    expect(seenOffsets).toEqual([1, 2]);
  });
});

describe('name -> id resolution in filters', () => {
  it('resolves type and status names to ids', async () => {
    let filters = '';
    server.use(
      http.get(`${BASE}/api/v3/types`, () =>
        HttpResponse.json(halCollection([typeHal(1, 'Bug'), typeHal(7, 'Feature')])),
      ),
      http.get(`${BASE}/api/v3/statuses`, () =>
        HttpResponse.json(halCollection([statusHal(1, 'New'), statusHal(12, 'In progress')])),
      ),
      http.get(`${BASE}/api/v3/projects/:pid/work_packages`, ({ request }) => {
        filters = new URL(request.url).searchParams.get('filters') ?? '';
        return HttpResponse.json(halCollection([]));
      }),
    );
    await makeClient().listWorkPackages('demo', { types: ['Bug', 'Feature'], statuses: ['In progress'] });
    const parsed = JSON.parse(filters) as unknown[];
    expect(parsed).toContainEqual({ status: { operator: '=', values: ['12'] } });
    expect(parsed).toContainEqual({ type: { operator: '=', values: ['1', '7'] } });
  });
});

describe('updateWorkPackage lockVersion / 409', () => {
  it('re-fetches lockVersion and retries once on conflict', async () => {
    let getCount = 0;
    let patchCount = 0;
    server.use(
      http.get(`${BASE}/api/v3/work_packages/42`, () => {
        getCount += 1;
        return HttpResponse.json(workPackageHal({ lockVersion: getCount + 2 }));
      }),
      http.patch(`${BASE}/api/v3/work_packages/42`, async ({ request }) => {
        patchCount += 1;
        const body = (await request.json()) as { lockVersion: number };
        if (patchCount === 1) {
          return HttpResponse.json({ _type: 'Error', message: 'lock outdated' }, { status: 409 });
        }
        return HttpResponse.json(workPackageHal({ subject: `patched@${body.lockVersion}` }));
      }),
    );
    const res = await makeClient().updateWorkPackage(42, { subject: 'x' });
    expect(patchCount).toBe(2);
    expect(getCount).toBe(2);
    expect(res.subject).toBe('patched@4');
  });
});

describe('status transitions from the form', () => {
  it('discovers allowed transitions and sends the current lockVersion', async () => {
    let formBody: { lockVersion?: number } = {};
    server.use(
      http.get(`${BASE}/api/v3/work_packages/42`, () => HttpResponse.json(workPackageHal({ lockVersion: 7 }))),
      http.post(`${BASE}/api/v3/work_packages/42/form`, async ({ request }) => {
        formBody = (await request.json()) as typeof formBody;
        return HttpResponse.json(
          formHal([
            { id: 12, name: 'In progress' },
            { id: 15, name: 'Developed' },
          ]),
        );
      }),
    );
    const allowed = await makeClient().getAllowedStatusTransitions(42);
    expect(allowed).toEqual([
      { id: 12, name: 'In progress' },
      { id: 15, name: 'Developed' },
    ]);
    // The form endpoint 409s without the current lockVersion.
    expect(formBody).toEqual({ lockVersion: 7 });
  });

  it('rejects a transition the form does not permit', async () => {
    server.use(
      http.get(`${BASE}/api/v3/statuses`, () =>
        HttpResponse.json(halCollection([statusHal(1, 'New'), statusHal(99, 'Closed')])),
      ),
      http.get(`${BASE}/api/v3/work_packages/42`, () => HttpResponse.json(workPackageHal({ lockVersion: 3 }))),
      http.post(`${BASE}/api/v3/work_packages/42/form`, () =>
        HttpResponse.json(formHal([{ id: 12, name: 'In progress' }])),
      ),
    );
    await expect(makeClient().updateStatus(42, 'Closed')).rejects.toBeInstanceOf(UnprocessableError);
  });

  it('PATCHes status when the transition is allowed', async () => {
    let patched: { lockVersion?: number; _links?: { status?: { href?: string } } } = {};
    server.use(
      http.get(`${BASE}/api/v3/statuses`, () =>
        HttpResponse.json(halCollection([statusHal(12, 'In progress')])),
      ),
      http.post(`${BASE}/api/v3/work_packages/42/form`, () =>
        HttpResponse.json(formHal([{ id: 12, name: 'In progress' }])),
      ),
      http.get(`${BASE}/api/v3/work_packages/42`, () => HttpResponse.json(workPackageHal({ lockVersion: 4 }))),
      http.patch(`${BASE}/api/v3/work_packages/42`, async ({ request }) => {
        patched = (await request.json()) as typeof patched;
        return HttpResponse.json(workPackageHal());
      }),
    );
    await makeClient().updateStatus(42, 'In progress');
    expect(patched._links?.status?.href).toBe('/api/v3/statuses/12');
    expect(patched.lockVersion).toBe(4);
  });
});

describe('getWorkPackage assembly', () => {
  it('combines detail, comments (non-empty), relations, attachments', async () => {
    server.use(
      http.get(`${BASE}/api/v3/work_packages/42`, () => HttpResponse.json(workPackageHal())),
      http.get(`${BASE}/api/v3/work_packages/42/activities`, () =>
        HttpResponse.json(halCollection([activityHal(10, 'first comment'), activityHal(11, '')])),
      ),
      http.get(`${BASE}/api/v3/work_packages/42/relations`, () => HttpResponse.json(halCollection([]))),
      http.get(`${BASE}/api/v3/work_packages/42/attachments`, () => HttpResponse.json(halCollection([]))),
    );
    const wp = await makeClient().getWorkPackage(42);
    expect(wp.subject).toBe('Fix the login crash');
    expect(wp.description).toBe('Steps to reproduce...');
    expect(wp.comments).toHaveLength(1);
    expect(wp.comments[0]?.comment).toBe('first comment');
    expect(wp.relations).toContainEqual(expect.objectContaining({ type: 'parent', targetId: 40 }));
  });
});

describe('downloadAttachment', () => {
  it('fetches the attachment resource then its binary content', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    server.use(
      http.get(`${BASE}/api/v3/attachments/52`, () =>
        HttpResponse.json({
          _type: 'Attachment',
          id: 52,
          fileName: '1.png',
          contentType: 'image/png',
          fileSize: 7,
          _links: {
            self: { href: '/api/v3/attachments/52' },
            downloadLocation: { href: '/api/v3/attachments/52/content' },
          },
        }),
      ),
      http.get(`${BASE}/api/v3/attachments/52/content`, () =>
        new HttpResponse(png, { headers: { 'Content-Type': 'image/png' } }),
      ),
    );
    const att = await makeClient().downloadAttachment(52);
    expect(att).toMatchObject({ id: 52, fileName: '1.png', contentType: 'image/png', fileSize: 7 });
    expect(Buffer.isBuffer(att.data)).toBe(true);
    expect(att.data.length).toBe(7);
    expect(att.data[0]).toBe(0x89);
  });
});

describe('journal / schema / create', () => {
  it('getJournal maps change entries with detail lines and internal flag', async () => {
    server.use(
      http.get(`${BASE}/api/v3/work_packages/287/activities`, () =>
        HttpResponse.json(
          halCollection([
            {
              _type: 'Activity',
              id: 629,
              version: 1,
              internal: false,
              createdAt: '2026-07-01T00:00:00Z',
              comment: { format: 'markdown', raw: '', html: '' },
              details: [
                { format: 'markdown', raw: 'Type set to Bug', html: '' },
                { format: 'markdown', raw: 'Status changed from New to Developed', html: '' },
              ],
              _links: { user: { href: '/api/v3/users/9', title: 'Kürşat' } },
            },
            {
              _type: 'Activity::Comment',
              id: 655,
              version: 2,
              internal: false,
              createdAt: '2026-07-13T21:30:00Z',
              comment: { format: 'markdown', raw: 'Kök neden analizi', html: '' },
              details: [],
              _links: { user: { href: '/api/v3/users/9' } },
            },
          ]),
        ),
      ),
    );
    const journal = await makeClient().getJournal(287);
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({
      id: 629,
      kind: 'change',
      author: 'Kürşat',
      authorId: 9,
      details: ['Type set to Bug', 'Status changed from New to Developed'],
      version: 1,
      internal: false,
    });
    expect(journal[1]).toMatchObject({ id: 655, kind: 'comment', comment: 'Kök neden analizi', authorId: 9 });
  });

  it('getWorkPackageSchema follows the schema link and maps fields + custom fields', async () => {
    server.use(
      http.get(`${BASE}/api/v3/work_packages/42`, () =>
        HttpResponse.json(workPackageHal({ _links: { schema: { href: '/api/v3/work_packages/schemas/6-7' } } })),
      ),
      http.get(`${BASE}/api/v3/work_packages/schemas/6-7`, () =>
        HttpResponse.json({
          _type: 'Schema',
          _links: { self: { href: '/api/v3/work_packages/schemas/6-7' } },
          subject: { type: 'String', name: 'Subject', required: true, writable: true },
          status: { type: 'Status', name: 'Status', required: true, writable: true },
          customField1: { type: 'String', name: 'Müşteri Kodu', required: false, writable: true },
        }),
      ),
    );
    const schema = await makeClient().getWorkPackageSchema(42);
    expect(schema.id).toBe('6-7');
    expect(schema.fields).toContainEqual({ key: 'subject', name: 'Subject', type: 'String', required: true, writable: true });
    expect(schema.customFields).toEqual([
      { key: 'customField1', name: 'Müşteri Kodu', type: 'String', required: false, writable: true },
    ]);
  });

  it('createWorkPackage resolves names and POSTs the right body', async () => {
    let posted: Record<string, unknown> = {};
    server.use(
      http.get(`${BASE}/api/v3/types`, () => HttpResponse.json(halCollection([typeHal(1, 'Bug'), typeHal(7, 'Feature')]))),
      http.get(`${BASE}/api/v3/users/me`, () => HttpResponse.json({ _type: 'User', id: 9, name: 'Me', login: 'me' })),
      http.post(`${BASE}/api/v3/projects/demo/work_packages`, async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(workPackageHal({ id: 301, subject: 'Yeni istek' }));
      }),
    );
    const created = await makeClient().createWorkPackage('demo', {
      type: 'Feature',
      subject: 'Yeni istek',
      description: 'Detaylar...',
      assignee: 'me',
    });
    expect(created.id).toBe(301);
    expect(posted).toMatchObject({
      subject: 'Yeni istek',
      description: { format: 'markdown', raw: 'Detaylar...' },
      _links: { type: { href: '/api/v3/types/7' }, assignee: { href: '/api/v3/users/9' } },
    });
  });
});

describe('boards', () => {
  const gridsResponse = halCollection([
    {
      _type: 'Grid',
      id: 18,
      name: 'Kanban',
      _links: { scope: { href: '/projects/demo/boards' } },
      widgets: [
        { identifier: 'work_package_query', startColumn: 1, options: { queryId: 55, filters: [{ status_id: { operator: '=', values: ['1'] } }] } },
        { identifier: 'work_package_query', startColumn: 2, options: { queryId: 56, filters: [{ status: { operator: '=', values: ['7'] } }] } },
      ],
    },
    { _type: 'Grid', id: 11, name: null, _links: { scope: { href: '/my/page' } }, widgets: [] },
  ]);
  const statusesResponse = halCollection([statusHal(1, 'New'), statusHal(7, 'In progress')]);

  it('lists boards with resolved columns, ignoring non-board grids', async () => {
    server.use(
      http.get(`${BASE}/api/v3/grids`, () => HttpResponse.json(gridsResponse)),
      http.get(`${BASE}/api/v3/statuses`, () => HttpResponse.json(statusesResponse)),
    );
    const boards = await makeClient().listBoards('demo');
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ id: 18, name: 'Kanban', projectIdentifier: 'demo' });
    expect(boards[0]?.columns).toEqual([
      { name: 'New', queryId: 55, statusId: 1, position: 1 },
      { name: 'In progress', queryId: 56, statusId: 7, position: 2 },
    ]);
  });

  it('getBoard throws NotFoundError for an unknown board name', async () => {
    server.use(
      http.get(`${BASE}/api/v3/grids`, () => HttpResponse.json(gridsResponse)),
      http.get(`${BASE}/api/v3/statuses`, () => HttpResponse.json(statusesResponse)),
    );
    await expect(makeClient().getBoard('Nope', 'demo')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('runs a board column via query_id scoped to the project', async () => {
    let queryId: string | null = null;
    let scopedProject: string | undefined;
    server.use(
      http.get(`${BASE}/api/v3/projects/:pid/work_packages`, ({ request, params }) => {
        queryId = new URL(request.url).searchParams.get('query_id');
        scopedProject = params.pid as string;
        return HttpResponse.json(halCollection([workPackageHal({ id: 287, subject: 'first' })], { total: 1 }));
      }),
    );
    const page = await makeClient().listBoardColumnWorkPackages('demo', 55);
    expect(queryId).toBe('55');
    expect(scopedProject).toBe('demo');
    expect(page.elements[0]?.id).toBe(287);
  });
});
