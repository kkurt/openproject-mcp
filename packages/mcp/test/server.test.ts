import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OpenProjectClient } from '@openproject-agent/core';
import { createServer } from '@openproject-agent/mcp';

const summary = {
  id: 42,
  type: 'Bug',
  subject: 'Fix the login crash',
  status: 'New',
  priority: 'High',
  assignee: 'Alice',
  updatedAt: '2024-01-02T00:00:00Z',
  url: 'https://op.test/work_packages/42',
};

const detail = {
  ...summary,
  description: 'Steps to reproduce',
  project: { id: 3, name: 'Demo' },
  author: 'Bob',
  createdAt: null,
  startDate: null,
  dueDate: null,
  estimatedHours: null,
  percentageDone: null,
  lockVersion: 3,
  customFields: {},
  comments: [],
  relations: [],
  attachments: [],
};

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn(async () => [
      { id: 3, identifier: 'demo', name: 'Demo', active: true, description: null, url: 'https://op.test/projects/demo' },
    ]),
    listWorkPackages: vi.fn(async () => ({ total: 1, count: 1, pageSize: 50, offset: 1, elements: [summary] })),
    getWorkPackage: vi.fn(async () => detail),
    listStatuses: vi.fn(async () => [
      { id: 12, name: 'In progress', isClosed: false },
      { id: 99, name: 'Closed', isClosed: true },
    ]),
    listTypes: vi.fn(async () => [{ id: 1, name: 'Bug' }]),
    listPriorities: vi.fn(async () => [{ id: 8, name: 'High' }]),
    getAllowedStatusTransitions: vi.fn(async () => [{ id: 12, name: 'In progress' }]),
    addComment: vi.fn(async () => ({ id: 100, author: 'Me', comment: 'noted', createdAt: null })),
    updateStatus: vi.fn(async () => summary),
    assign: vi.fn(async () => summary),
    logTime: vi.fn(async () => undefined),
    downloadAttachment: vi.fn(async () => ({
      id: 52,
      fileName: '1.png',
      contentType: 'image/png',
      fileSize: 7,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    })),
    listBoards: vi.fn(async () => [
      { id: 18, name: 'Kanban', projectIdentifier: 'demo', columns: [{ name: 'New', queryId: 55, statusId: 1, position: 1 }] },
    ]),
    getBoard: vi.fn(async () => ({
      id: 18,
      name: 'Kanban',
      projectIdentifier: 'demo',
      columns: [{ name: 'New', queryId: 55, statusId: 1, position: 1 }],
    })),
    listBoardColumnWorkPackages: vi.fn(async () => ({ total: 1, count: 1, pageSize: 50, offset: 1, elements: [summary] })),
    getJournal: vi.fn(async () => [
      { id: 629, kind: 'change', author: 'K', authorId: 9, comment: '', details: ['Status changed from New to Developed'], version: 1, internal: false, createdAt: null },
    ]),
    getWorkPackageSchema: vi.fn(async () => ({
      id: '6-7',
      fields: [{ key: 'subject', name: 'Subject', type: 'String', required: true, writable: true }],
      customFields: [],
    })),
    createWorkPackage: vi.fn(async () => summary),
    previewWorkPackageEdit: vi.fn(async () => ({
      workPackageId: 42,
      lockVersion: 3,
      changes: { subject: { from: 'Fix the login crash', to: 'Renamed' } },
    })),
    editWorkPackage: vi.fn(async () => ({
      workPackage: summary,
      changes: { subject: { from: 'Fix the login crash', to: 'Renamed' } },
      lockVersion: 4,
    })),
    ...overrides,
  };
}

type MockClient = ReturnType<typeof makeMockClient>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function harness(
  opts: { readOnly?: boolean; protectedTransitions?: string[]; client?: Record<string, unknown> } = {},
): Promise<{ mcpClient: Client; mock: MockClient }> {
  const mock = makeMockClient(opts.client);
  const server = createServer({
    client: mock as unknown as OpenProjectClient,
    readOnly: opts.readOnly ?? false,
    protectedTransitions: opts.protectedTransitions ?? ['Closed', 'Rejected'],
    startStatus: 'In progress',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  cleanups.push(async () => {
    await mcpClient.close();
    await server.close();
  });
  return { mcpClient, mock };
}

async function call(mcpClient: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await mcpClient.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return { isError: res.isError === true, text, content, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe('tool registration', () => {
  it('registers every read and write tool with a valid JSON input schema', async () => {
    const { mcpClient } = await harness();
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_comment',
        'assign_work_package',
        'create_work_package',
        'get_allowed_status_transitions',
        'get_attachment',
        'get_board',
        'get_journal',
        'get_next_board_card',
        'get_next_work_package',
        'get_work_package',
        'get_work_package_schema',
        'list_board_column',
        'list_boards',
        'list_priorities',
        'list_projects',
        'list_statuses',
        'list_types',
        'list_work_packages',
        'log_time',
        'start_work_package',
        'update_work_package',
        'update_work_package_status',
      ].sort(),
    );
    // zod -> JSON schema conversion actually happened.
    const listWp = tools.find((t) => t.name === 'list_work_packages');
    expect(listWp?.inputSchema?.properties).toHaveProperty('projectId');
    expect(listWp?.inputSchema?.properties).toHaveProperty('statuses');
  });
});

describe('read tools return compact DTOs', () => {
  it('list_projects', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'list_projects');
    expect(json()).toEqual([
      { id: 3, identifier: 'demo', name: 'Demo', active: true, description: null, url: 'https://op.test/projects/demo' },
    ]);
  });

  it('list_work_packages wraps summaries with paging info', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'list_work_packages', { projectId: 'demo', types: ['Bug'] });
    expect(json()).toMatchObject({ total: 1, workPackages: [summary] });
    expect(mock.listWorkPackages).toHaveBeenCalledWith('demo', expect.objectContaining({ types: ['Bug'] }));
  });

  it('get_work_package returns full detail', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'get_work_package', { id: 42 });
    expect(json()).toMatchObject({ id: 42, description: 'Steps to reproduce', lockVersion: 3 });
  });
});

describe('write tools: dryRun and read-only', () => {
  it('add_comment dryRun previews without writing', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'add_comment', { workPackageId: 42, markdown: 'hello', dryRun: true });
    expect(json()).toMatchObject({ dryRun: true, action: 'add_comment', markdown: 'hello' });
    expect(mock.addComment).not.toHaveBeenCalled();
  });

  it('add_comment actually writes when not dryRun', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'add_comment', { workPackageId: 42, markdown: 'hello' });
    expect(json()).toMatchObject({ ok: true });
    expect(mock.addComment).toHaveBeenCalledWith(42, 'hello');
  });

  it('read-only mode refuses a real write', async () => {
    const { mcpClient, mock } = await harness({ readOnly: true });
    const { isError, text } = await call(mcpClient, 'add_comment', { workPackageId: 42, markdown: 'hello' });
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/i);
    expect(mock.addComment).not.toHaveBeenCalled();
  });
});

describe('status transition safety', () => {
  it('refuses a protected transition (Closed) even outside dryRun', async () => {
    const { mcpClient, mock } = await harness();
    const { isError, text } = await call(mcpClient, 'update_work_package_status', { workPackageId: 42, status: 'Closed' });
    expect(isError).toBe(true);
    expect(text).toMatch(/PROTECTED/);
    expect(mock.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a transition the form does not allow', async () => {
    const { mcpClient, mock } = await harness({
      client: { getAllowedStatusTransitions: vi.fn(async () => [{ id: 15, name: 'Developed' }]) },
    });
    const { isError, text } = await call(mcpClient, 'update_work_package_status', { workPackageId: 42, status: 'In progress' });
    expect(isError).toBe(true);
    expect(text).toMatch(/not allowed/);
    expect(mock.updateStatus).not.toHaveBeenCalled();
  });

  it('performs an allowed, non-protected transition', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'update_work_package_status', { workPackageId: 42, status: 'In progress' });
    expect(json()).toMatchObject({ ok: true });
    expect(mock.updateStatus).toHaveBeenCalledWith(42, 'In progress');
  });

  it('get_allowed_status_transitions surfaces the form values', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'get_allowed_status_transitions', { workPackageId: 42 });
    expect(json()).toEqual([{ id: 12, name: 'In progress' }]);
  });

  it('start_work_package moves the WP to the configured start status', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'start_work_package', { workPackageId: 42 });
    expect(json()).toMatchObject({ ok: true });
    expect(mock.updateStatus).toHaveBeenCalledWith(42, 'In progress');
  });

  it('start_work_package dryRun previews without writing', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'start_work_package', { workPackageId: 42, dryRun: true });
    expect(json()).toMatchObject({ dryRun: true, wouldTransitionTo: 'In progress' });
    expect(mock.updateStatus).not.toHaveBeenCalled();
  });
});

describe('get_attachment', () => {
  it('returns an image as a viewable image content block', async () => {
    const { mcpClient } = await harness();
    const { content } = await call(mcpClient, 'get_attachment', { attachmentId: 52 });
    const image = content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
  });

  it('inlines a text attachment', async () => {
    const { mcpClient } = await harness({
      client: {
        downloadAttachment: vi.fn(async () => ({
          id: 9,
          fileName: 'error.log',
          contentType: 'text/plain',
          fileSize: 5,
          data: Buffer.from('boom!'),
        })),
      },
    });
    const { text } = await call(mcpClient, 'get_attachment', { attachmentId: 9 });
    expect(text).toContain('error.log');
    expect(text).toContain('boom!');
  });

  it('does not inline an oversized attachment', async () => {
    const { mcpClient } = await harness({
      client: {
        downloadAttachment: vi.fn(async () => ({
          id: 9,
          fileName: 'big.bin',
          contentType: 'application/octet-stream',
          fileSize: 100,
          data: Buffer.alloc(100),
        })),
      },
    });
    const { text } = await call(mcpClient, 'get_attachment', { attachmentId: 9, maxBytes: 10 });
    expect(text).toMatch(/not inlined/);
  });
});

describe('journal / schema / create tools', () => {
  it('get_journal returns change entries with detail lines', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'get_journal', { workPackageId: 287 });
    expect(json()).toMatchObject([{ id: 629, kind: 'change', details: ['Status changed from New to Developed'] }]);
  });

  it('get_work_package_schema returns the compact schema', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'get_work_package_schema', { workPackageId: 42 });
    expect(json()).toMatchObject({ id: '6-7', fields: [{ key: 'subject' }] });
  });

  it('create_work_package dryRun previews without writing', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'create_work_package', {
      projectId: 'demo',
      type: 'Feature',
      subject: 'Yeni istek',
      dryRun: true,
    });
    expect(json()).toMatchObject({ dryRun: true, action: 'create_work_package', subject: 'Yeni istek' });
    expect(mock.createWorkPackage).not.toHaveBeenCalled();
  });

  it('create_work_package writes when allowed and refuses in read-only', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'create_work_package', { projectId: 'demo', type: 'Bug', subject: 'X' });
    expect(json()).toMatchObject({ ok: true });
    expect(mock.createWorkPackage).toHaveBeenCalledWith('demo', expect.objectContaining({ type: 'Bug', subject: 'X' }));

    const ro = await harness({ readOnly: true });
    const res = await call(ro.mcpClient, 'create_work_package', { projectId: 'demo', type: 'Bug', subject: 'X' });
    expect(res.isError).toBe(true);
    expect(ro.mock.createWorkPackage).not.toHaveBeenCalled();
  });
});

describe('update_work_package', () => {
  it('dryRun returns the before/after diff without writing', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'update_work_package', { workPackageId: 42, subject: 'Renamed', dryRun: true });
    expect(json()).toMatchObject({
      dryRun: true,
      action: 'update_work_package',
      lockVersion: 3,
      changes: { subject: { from: 'Fix the login crash', to: 'Renamed' } },
    });
    expect(mock.previewWorkPackageEdit).toHaveBeenCalledWith(42, { subject: 'Renamed' });
    expect(mock.editWorkPackage).not.toHaveBeenCalled();
  });

  it('writes the given fields, passing null clears and lockVersion through', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'update_work_package', {
      workPackageId: 42,
      description: '## Acceptance',
      descriptionMode: 'append',
      dueDate: null,
      assignee: null,
      lockVersion: 3,
    });
    expect(json()).toMatchObject({ ok: true, lockVersion: 4, workPackage: { id: 42 } });
    expect(mock.editWorkPackage).toHaveBeenCalledWith(42, {
      description: '## Acceptance',
      descriptionMode: 'append',
      dueDate: null,
      assignee: null,
      lockVersion: 3,
    });
  });

  it('refuses an update with no fields', async () => {
    const { mcpClient, mock } = await harness();
    const { isError, text } = await call(mcpClient, 'update_work_package', { workPackageId: 42, lockVersion: 3 });
    expect(isError).toBe(true);
    expect(text).toMatch(/nothing to update/i);
    expect(mock.editWorkPackage).not.toHaveBeenCalled();
  });

  it('read-only mode refuses a real update but still previews', async () => {
    const { mcpClient, mock } = await harness({ readOnly: true });
    const res = await call(mcpClient, 'update_work_package', { workPackageId: 42, subject: 'Renamed' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/read-only/i);
    expect(mock.editWorkPackage).not.toHaveBeenCalled();

    const preview = await call(mcpClient, 'update_work_package', { workPackageId: 42, subject: 'Renamed', dryRun: true });
    expect(preview.isError).toBe(false);
  });

  it('rejects malformed dates and out-of-range percentages', async () => {
    const { mcpClient, mock } = await harness();
    const badDate = await call(mcpClient, 'update_work_package', { workPackageId: 42, dueDate: '01.11.2026' });
    expect(badDate.isError).toBe(true);
    const badPct = await call(mcpClient, 'update_work_package', { workPackageId: 42, percentageDone: 120 });
    expect(badPct.isError).toBe(true);
    expect(mock.editWorkPackage).not.toHaveBeenCalled();
  });

  it('elides long description text in the reported changes', async () => {
    const long = `${'a'.repeat(1000)}TAIL`;
    const { mcpClient } = await harness({
      client: {
        editWorkPackage: vi.fn(async () => ({
          workPackage: summary,
          changes: { description: { from: 'short', to: long } },
          lockVersion: 4,
        })),
      },
    });
    const { json } = await call(mcpClient, 'update_work_package', { workPackageId: 42, description: long });
    const changes = json()['changes'] as { description: { from: string; to: string } };
    expect(changes.description.from).toBe('short');
    expect(changes.description.to.length).toBeLessThan(long.length);
    expect(changes.description.to.startsWith('aaa')).toBe(true);
    expect(changes.description.to.endsWith('TAIL')).toBe(true);
    expect(changes.description.to).toMatch(/chars omitted/);
  });
});

describe('board tools', () => {
  it('list_boards returns boards with columns', async () => {
    const { mcpClient } = await harness();
    const { json } = await call(mcpClient, 'list_boards', {});
    expect(json()).toMatchObject([{ name: 'Kanban', columns: [{ name: 'New', queryId: 55 }] }]);
  });

  it('list_board_column returns the column cards via its queryId', async () => {
    const { mcpClient, mock } = await harness();
    const { json } = await call(mcpClient, 'list_board_column', {
      projectId: 'demo',
      boardName: 'Kanban',
      columnName: 'New',
    });
    expect(json()).toMatchObject({ board: 'Kanban', column: 'New', workPackages: [summary] });
    expect(mock.listBoardColumnWorkPackages).toHaveBeenCalledWith('demo', 55, expect.anything());
  });

  it('list_board_column errors for an unknown column', async () => {
    const { mcpClient } = await harness();
    const { isError, text } = await call(mcpClient, 'list_board_column', {
      projectId: 'demo',
      boardName: 'Kanban',
      columnName: 'Nope',
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/no column/i);
  });
});
