/**
 * High-level OpenProject API v3 client. Returns compact DTOs, resolves friendly
 * names (types/statuses/priorities) to ids, handles pagination and the
 * lockVersion/409 update dance, and discovers allowed status transitions from
 * the work-package form.
 */
import { HttpClient, type HttpClientOptions } from './http.js';
import { ConflictError, NotFoundError, OpenProjectError, UnprocessableError } from './errors.js';
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
  type Filter,
  type SortBy,
} from './filters.js';
import * as map from './map.js';
import type {
  ActivityDTO,
  AttachmentDTO,
  BoardColumnDTO,
  BoardDTO,
  CommentDTO,
  CreateWorkPackageParams,
  EditableWorkPackageFields,
  HalCollection,
  HalResource,
  PriorityDTO,
  ProjectDTO,
  RelationDTO,
  StatusDTO,
  StatusTransitionDTO,
  TypeDTO,
  UpdateWorkPackageParams,
  UserDTO,
  WorkPackageChanges,
  WorkPackageCollectionResult,
  WorkPackageDetailDTO,
  WorkPackageEditPreview,
  WorkPackageEditResult,
  WorkPackageSchemaDTO,
  WorkPackageSummaryDTO,
} from './types.js';

export interface ListWorkPackagesParams {
  /** Type names or ids (e.g. ["Bug","Feature"] or ["1","7"]). */
  types?: string[];
  /** Status names or ids; the special values "open" / "closed" are honored. Default: open. */
  statuses?: string[];
  /** "me", a numeric user id, or a user id string. */
  assignee?: string;
  /** Priority names or ids. */
  priority?: string[];
  /** ISO timestamp; only work packages updated on/after it. */
  updatedAfter?: string;
  /** Full-text search. */
  search?: string;
  /** Sort pairs. Default: priority desc, then id asc. */
  sortBy?: SortBy;
  pageSize?: number;
  /** 1-based page offset (OpenProject convention). Default 1. */
  offset?: number;
}

const DEFAULT_SORT: SortBy = [
  ['priority', 'desc'],
  ['id', 'asc'],
];

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Convert decimal hours to an ISO-8601 duration (e.g. 1.5 -> "PT1H30M"). */
export function hoursToIso8601(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  return out === 'PT' ? 'PT0H' : out;
}

function lockVersionOf(wp: HalResource): number {
  return typeof wp['lockVersion'] === 'number' ? wp['lockVersion'] : 0;
}

/** Refuse an edit based on a read that someone else's change has since superseded. */
function assertLockVersionFresh(id: number | string, expected: number, current: number): void {
  if (expected !== current) {
    throw new ConflictError(
      `Work package ${id} was modified after lockVersion ${expected} was read (current: ${current}). ` +
        'Re-read it and re-apply the change.',
      409,
    );
  }
}

/** Pull the status id out of a board widget's query filters, if it is status-based. */
function extractStatusId(filters: unknown): number | null {
  if (!Array.isArray(filters)) return null;
  for (const f of filters) {
    if (f && typeof f === 'object') {
      const spec = (f as Record<string, { values?: unknown[] } | undefined>).status_id ??
        (f as Record<string, { values?: unknown[] } | undefined>).status;
      const raw = spec?.values?.[0];
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export class OpenProjectClient {
  readonly http: HttpClient;
  readonly baseUrl: string;

  private statusCache: StatusDTO[] | undefined;
  private typeCache: TypeDTO[] | undefined;
  private priorityCache: PriorityDTO[] | undefined;
  private currentUserCache: UserDTO | undefined;

  constructor(options: HttpClientOptions | { http: HttpClient }) {
    this.http = 'http' in options ? options.http : new HttpClient(options);
    this.baseUrl = this.http.baseUrl;
  }

  // --- reference data (cached) ---------------------------------------------

  async listProjects(): Promise<ProjectDTO[]> {
    const col = await this.http.get<HalCollection>('/projects', { query: { pageSize: 200 } });
    return (col._embedded?.elements ?? []).map((e) => map.mapProject(e, this.baseUrl));
  }

  async getProject(idOrIdentifier: string | number): Promise<ProjectDTO> {
    const hal = await this.http.get<HalResource>(`/projects/${encodeURIComponent(String(idOrIdentifier))}`);
    return map.mapProject(hal, this.baseUrl);
  }

  async listStatuses(): Promise<StatusDTO[]> {
    if (!this.statusCache) {
      const col = await this.http.get<HalCollection>('/statuses', { query: { pageSize: 200 } });
      this.statusCache = (col._embedded?.elements ?? []).map(map.mapStatus);
    }
    return this.statusCache;
  }

  async listTypes(): Promise<TypeDTO[]> {
    if (!this.typeCache) {
      const col = await this.http.get<HalCollection>('/types', { query: { pageSize: 200 } });
      this.typeCache = (col._embedded?.elements ?? []).map(map.mapType);
    }
    return this.typeCache;
  }

  async listPriorities(): Promise<PriorityDTO[]> {
    if (!this.priorityCache) {
      const col = await this.http.get<HalCollection>('/priorities', { query: { pageSize: 200 } });
      this.priorityCache = (col._embedded?.elements ?? []).map(map.mapPriority);
    }
    return this.priorityCache;
  }

  async getCurrentUser(): Promise<UserDTO> {
    if (!this.currentUserCache) {
      const hal = await this.http.get<HalResource>('/users/me');
      this.currentUserCache = map.mapUser(hal);
    }
    return this.currentUserCache;
  }

  // --- boards (OpenProject stores boards as grids) -------------------------

  /** List boards. Optionally restrict to one project (by identifier). */
  async listBoards(projectId?: string | number): Promise<BoardDTO[]> {
    const [col, statuses] = await Promise.all([
      this.http.get<HalCollection>('/grids', { query: { pageSize: 200 } }),
      this.listStatuses(),
    ]);
    const statusName = (id: number | null): string | null =>
      id == null ? null : (statuses.find((s) => s.id === id)?.name ?? null);

    const boards: BoardDTO[] = [];
    for (const grid of col._embedded?.elements ?? []) {
      const scopeLink = grid._links?.['scope'];
      const scope = (Array.isArray(scopeLink) ? scopeLink[0] : scopeLink)?.href ?? '';
      if (!/\/boards\/?$/.test(scope)) continue; // only board grids

      const identifier = /\/projects\/([^/]+)\/boards\/?$/.exec(scope)?.[1] ?? null;
      if (projectId != null && identifier !== String(projectId)) continue;

      const widgets = (Array.isArray(grid['widgets']) ? grid['widgets'] : []) as Array<Record<string, unknown>>;
      const columns: BoardColumnDTO[] = widgets
        .filter((w) => w['identifier'] === 'work_package_query')
        .sort((a, b) => Number(a['startColumn'] ?? 0) - Number(b['startColumn'] ?? 0))
        .map((w, i) => {
          const opts = (w['options'] ?? {}) as Record<string, unknown>;
          const queryId = Number(opts['queryId'] ?? opts['query_id']);
          const statusId = extractStatusId(opts['filters']);
          return { name: statusName(statusId) ?? `Column ${i + 1}`, queryId, statusId, position: i + 1 };
        })
        .filter((c) => Number.isFinite(c.queryId));

      boards.push({ id: grid.id ?? 0, name: String(grid['name'] ?? ''), projectIdentifier: identifier, columns });
    }
    return boards;
  }

  /** Find a board by name within a project (throws if none or ambiguous). */
  async getBoard(name: string, projectId: string | number): Promise<BoardDTO> {
    const boards = await this.listBoards(projectId);
    const matches = boards.filter((b) => b.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) {
      throw new NotFoundError(
        `No board named '${name}' in project '${projectId}'. Available: ${boards.map((b) => b.name).join(', ') || '(none)'}`,
        404,
      );
    }
    if (matches.length > 1) {
      throw new OpenProjectError(`Multiple boards named '${name}' in project '${projectId}'; rename to disambiguate.`, 409);
    }
    return matches[0]!;
  }

  /** Cards in a board column, via its saved query scoped to the project (preserves board order). */
  async listBoardColumnWorkPackages(
    projectId: string | number,
    queryId: number,
    params: { pageSize?: number; offset?: number } = {},
  ): Promise<WorkPackageCollectionResult> {
    const query = { query_id: queryId, pageSize: params.pageSize ?? 50, offset: params.offset ?? 1 };
    const col = await this.http.get<HalCollection>(
      `/projects/${encodeURIComponent(String(projectId))}/work_packages`,
      { query },
    );
    return {
      elements: (col._embedded?.elements ?? []).map((e) => map.mapWorkPackageSummary(e, this.baseUrl)),
      total: col.total,
      count: col.count,
      pageSize: col.pageSize,
      offset: col.offset,
    };
  }

  async listAllBoardColumnWorkPackages(
    projectId: string | number,
    queryId: number,
  ): Promise<WorkPackageSummaryDTO[]> {
    const pageSize = 100;
    const all: WorkPackageSummaryDTO[] = [];
    let offset = 1;
    for (;;) {
      const page = await this.listBoardColumnWorkPackages(projectId, queryId, { pageSize, offset });
      all.push(...page.elements);
      if (page.elements.length === 0 || all.length >= page.total) break;
      offset += 1;
    }
    return all;
  }

  // --- name -> id resolution -----------------------------------------------

  private resolve(items: Array<{ id: number; name: string }>, value: string, kind: string): number {
    if (isNumericId(value)) return Number(value);
    const found = items.find((i) => i.name.toLowerCase() === value.toLowerCase());
    if (!found) {
      throw new NotFoundError(
        `Unknown ${kind}: '${value}'. Known: ${items.map((i) => i.name).join(', ') || '(none)'}`,
        404,
      );
    }
    return found.id;
  }

  private async resolveTypeIds(values: string[]): Promise<string[]> {
    const types = await this.listTypes();
    return values.map((v) => String(this.resolve(types, v, 'type')));
  }

  private async resolveStatusIds(values: string[]): Promise<string[]> {
    const statuses = await this.listStatuses();
    return values.map((v) => String(this.resolve(statuses, v, 'status')));
  }

  private async resolvePriorityIds(values: string[]): Promise<string[]> {
    const priorities = await this.listPriorities();
    return values.map((v) => String(this.resolve(priorities, v, 'priority')));
  }

  private async resolveStatusId(value: string | number): Promise<number> {
    const asString = String(value);
    if (isNumericId(asString)) return Number(asString);
    const statuses = await this.listStatuses();
    return this.resolve(statuses, asString, 'status');
  }

  private async resolveAssigneeId(value: string): Promise<number> {
    if (value === 'me') return (await this.getCurrentUser()).id;
    if (isNumericId(value)) return Number(value);
    throw new NotFoundError(`Cannot resolve user '${value}'. Pass a numeric user id or 'me'.`, 404);
  }

  // --- work packages -------------------------------------------------------

  private async buildFilters(params: ListWorkPackagesParams): Promise<Filter[]> {
    const filters: Filter[] = [];

    const statuses = params.statuses ?? [];
    const lowered = statuses.map((s) => s.toLowerCase());
    if (statuses.length === 0 || lowered.includes('open')) {
      filters.push(openStatusFilter());
    } else if (lowered.includes('closed')) {
      filters.push(closedStatusFilter());
    } else {
      filters.push(statusIdFilter(await this.resolveStatusIds(statuses)));
    }

    if (params.types?.length) filters.push(typeIdFilter(await this.resolveTypeIds(params.types)));
    if (params.priority?.length) filters.push(priorityIdFilter(await this.resolvePriorityIds(params.priority)));
    if (params.assignee) filters.push(assigneeIdFilter([String(await this.resolveAssigneeId(params.assignee))]));
    if (params.updatedAfter) filters.push(updatedAfterFilter(params.updatedAfter));
    if (params.search) filters.push(searchFilter(params.search));

    return filters;
  }

  async listWorkPackages(
    projectId: string | number,
    params: ListWorkPackagesParams = {},
  ): Promise<WorkPackageCollectionResult> {
    const filters = await this.buildFilters(params);
    const query = {
      filters: serializeFilters(filters),
      sortBy: serializeSortBy(params.sortBy ?? DEFAULT_SORT),
      pageSize: params.pageSize ?? 50,
      offset: params.offset ?? 1,
    };
    const col = await this.http.get<HalCollection>(
      `/projects/${encodeURIComponent(String(projectId))}/work_packages`,
      { query },
    );
    return {
      elements: (col._embedded?.elements ?? []).map((e) => map.mapWorkPackageSummary(e, this.baseUrl)),
      total: col.total,
      count: col.count,
      pageSize: col.pageSize,
      offset: col.offset,
    };
  }

  /** Fetch every matching work package by walking pages (offset starts at 1). */
  async listAllWorkPackages(
    projectId: string | number,
    params: ListWorkPackagesParams = {},
  ): Promise<WorkPackageSummaryDTO[]> {
    const pageSize = params.pageSize ?? 100;
    const all: WorkPackageSummaryDTO[] = [];
    let offset = params.offset ?? 1;
    for (;;) {
      const page = await this.listWorkPackages(projectId, { ...params, pageSize, offset });
      all.push(...page.elements);
      if (page.elements.length === 0 || all.length >= page.total) break;
      offset += 1;
    }
    return all;
  }

  async getWorkPackage(id: number | string): Promise<WorkPackageDetailDTO> {
    const [wp, comments, relations, attachments] = await Promise.all([
      this.http.get<HalResource>(`/work_packages/${id}`),
      this.getActivities(id),
      this.getRelations(id),
      this.getAttachments(id),
    ]);
    return map.mapWorkPackageDetail(wp, { comments, relations, attachments }, this.baseUrl);
  }

  async getActivities(id: number | string): Promise<CommentDTO[]> {
    const col = await this.http.get<HalCollection>(`/work_packages/${id}/activities`);
    return (col._embedded?.elements ?? [])
      .map(map.mapComment)
      .filter((c) => c.comment.trim().length > 0);
  }

  /** Full journal: every activity including pure change entries (status changes etc.). */
  async getJournal(id: number | string): Promise<ActivityDTO[]> {
    const col = await this.http.get<HalCollection>(`/work_packages/${id}/activities`);
    return (col._embedded?.elements ?? []).map(map.mapActivity);
  }

  /** Field schema for a work package (types, required/writable flags, custom fields). */
  async getWorkPackageSchema(id: number | string): Promise<WorkPackageSchemaDTO> {
    const wp = await this.http.get<HalResource>(`/work_packages/${id}`);
    const schemaLink = wp._links?.['schema'];
    const href = (Array.isArray(schemaLink) ? schemaLink[0] : schemaLink)?.href;
    if (!href) throw new NotFoundError(`Work package ${id} exposes no schema link`, 404);
    const schema = await this.http.get<HalResource>(href.replace(/^\/api\/v3/, ''));
    return map.mapWorkPackageSchema(schema);
  }

  async getRelations(id: number | string): Promise<RelationDTO[]> {
    const col = await this.http.get<HalCollection>(`/work_packages/${id}/relations`);
    return (col._embedded?.elements ?? []).map((e) => map.mapRelation(e, Number(id)));
  }

  async getAttachments(id: number | string): Promise<AttachmentDTO[]> {
    const col = await this.http.get<HalCollection>(`/work_packages/${id}/attachments`);
    return (col._embedded?.elements ?? []).map((e) => map.mapAttachment(e, this.baseUrl));
  }

  /** Fetch an attachment's binary content (so an agent can view images / read text files). */
  async downloadAttachment(attachmentId: number | string): Promise<{
    id: number;
    fileName: string;
    contentType: string | null;
    fileSize: number | null;
    data: Buffer;
  }> {
    const att = await this.http.get<HalResource>(`/attachments/${attachmentId}`);
    const dto = map.mapAttachment(att, this.baseUrl);
    const links = att._links ?? {};
    const dl = (links['downloadLocation'] ?? links['staticDownloadLocation']) as { href?: string | null } | undefined;
    if (!dl?.href) {
      throw new NotFoundError(`Attachment ${attachmentId} has no download location`, 404);
    }
    const bin = await this.http.getBinaryByHref(dl.href);
    return {
      id: dto.id,
      fileName: dto.fileName,
      contentType: dto.contentType ?? bin.contentType,
      fileSize: dto.fileSize,
      data: bin.data,
    };
  }

  /** Discover the status transitions OpenProject currently permits for this WP (from its form). */
  async getAllowedStatusTransitions(id: number | string): Promise<StatusTransitionDTO[]> {
    // The form endpoint requires the current lockVersion in the body; omitting it
    // yields a 409 "conflicting modifications" (verified against a live instance).
    const lockVersion = await this.currentLockVersion(id);
    const form = await this.http.post<HalResource>(`/work_packages/${id}/form`, { lockVersion });
    const schema = (form._embedded as Record<string, unknown> | undefined)?.['schema'] as
      | Record<string, unknown>
      | undefined;
    const status = schema?.['status'] as HalResource | undefined;
    if (!status) return [];

    const embeddedAllowed = (status._embedded as Record<string, unknown> | undefined)?.['allowedValues'];
    if (Array.isArray(embeddedAllowed)) {
      return embeddedAllowed.map((s) => {
        const mapped = map.mapStatus(s as HalResource);
        return { id: mapped.id, name: mapped.name };
      });
    }

    const linkAllowed = status._links?.['allowedValues'];
    if (Array.isArray(linkAllowed)) {
      return linkAllowed.map((l) => ({ id: map.idFromHref(l.href) ?? 0, name: l.title ?? '' }));
    }
    return [];
  }

  // --- writes --------------------------------------------------------------

  async addComment(id: number | string, markdown: string): Promise<CommentDTO> {
    const res = await this.http.post<HalResource>(`/work_packages/${id}/activities`, {
      comment: { raw: markdown },
    });
    return map.mapComment(res);
  }

  private async currentLockVersion(id: number | string): Promise<number> {
    return lockVersionOf(await this.http.get<HalResource>(`/work_packages/${id}`));
  }

  /**
   * Read the work package, build a PATCH body from that read, and send it with
   * the read's lockVersion. On a 409 the read-build-write runs once more, so a
   * body derived from current values (e.g. an appended description) is rebuilt
   * from fresh data. With `expectedLockVersion` the caller's own read is the
   * baseline: a newer version, or a 409, is surfaced as a ConflictError instead.
   */
  private async patchFromCurrent(
    id: number | string,
    build: (current: HalResource) => Promise<Record<string, unknown>>,
    expectedLockVersion?: number,
  ): Promise<HalResource> {
    const attempt = async (): Promise<HalResource> => {
      const current = await this.http.get<HalResource>(`/work_packages/${id}`);
      const lockVersion = lockVersionOf(current);
      if (expectedLockVersion !== undefined) assertLockVersionFresh(id, expectedLockVersion, lockVersion);
      const body = await build(current);
      return this.http.patch<HalResource>(`/work_packages/${id}`, { lockVersion, ...body });
    };
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ConflictError && expectedLockVersion === undefined) return attempt();
      throw err;
    }
  }

  /**
   * PATCH a work package, injecting a fresh lockVersion. On a 409 conflict the
   * lockVersion is re-fetched and the PATCH is retried exactly once.
   */
  async updateWorkPackage(
    id: number | string,
    patch: Record<string, unknown>,
  ): Promise<WorkPackageSummaryDTO> {
    return map.mapWorkPackageSummary(await this.patchFromCurrent(id, async () => patch), this.baseUrl);
  }

  /** Translate edit params into a PATCH body plus the before/after of every touched field. */
  private async buildEdit(
    current: HalResource,
    params: UpdateWorkPackageParams,
  ): Promise<{ body: Record<string, unknown>; changes: WorkPackageChanges }> {
    const before = map.mapEditableFields(current);
    const body: Record<string, unknown> = {};
    const links: Record<string, { href: string | null }> = {};
    const changes: WorkPackageChanges = {};
    const change = <K extends keyof EditableWorkPackageFields>(key: K, to: EditableWorkPackageFields[K]): void => {
      // TS cannot relate a write through a generic key of a mapped type; the cast is sound.
      changes[key] = { from: before[key], to } as WorkPackageChanges[K];
    };
    const userHref = async (value: string | null): Promise<string | null> =>
      value === null ? null : `/api/v3/users/${await this.resolveAssigneeId(value)}`;

    if (params.subject !== undefined) {
      body['subject'] = params.subject;
      change('subject', params.subject);
    }
    if (params.description !== undefined) {
      const text =
        params.descriptionMode === 'append' && before.description.trim()
          ? `${before.description.trimEnd()}\n\n${params.description}`
          : params.description;
      body['description'] = { format: 'markdown', raw: text };
      change('description', text);
    }
    if (params.startDate !== undefined) {
      body['startDate'] = params.startDate;
      change('startDate', params.startDate);
    }
    if (params.dueDate !== undefined) {
      body['dueDate'] = params.dueDate;
      change('dueDate', params.dueDate);
    }
    if (params.estimatedHours !== undefined) {
      body['estimatedTime'] = params.estimatedHours === null ? null : hoursToIso8601(params.estimatedHours);
      change('estimatedHours', params.estimatedHours);
    }
    if (params.percentageDone !== undefined) {
      body['percentageDone'] = params.percentageDone;
      change('percentageDone', params.percentageDone);
    }
    if (params.priority !== undefined) {
      const priorities = await this.listPriorities();
      const priorityId = this.resolve(priorities, params.priority, 'priority');
      links['priority'] = { href: `/api/v3/priorities/${priorityId}` };
      change('priority', priorities.find((p) => p.id === priorityId)?.name ?? params.priority);
    }
    if (params.assignee !== undefined) {
      links['assignee'] = { href: await userHref(params.assignee) };
      change('assignee', params.assignee);
    }
    if (params.responsible !== undefined) {
      links['responsible'] = { href: await userHref(params.responsible) };
      change('responsible', params.responsible);
    }
    if (params.parentId !== undefined) {
      links['parent'] = { href: params.parentId === null ? null : `/api/v3/work_packages/${params.parentId}` };
      change('parentId', params.parentId);
    }
    if (Object.keys(links).length > 0) body['_links'] = links;
    return { body, changes };
  }

  /**
   * Edit work-package fields; omitted fields are left as-is. Status is not
   * editable here on purpose: updateStatus checks the allowed transitions.
   */
  async editWorkPackage(id: number | string, params: UpdateWorkPackageParams): Promise<WorkPackageEditResult> {
    let changes: WorkPackageChanges = {};
    const updated = await this.patchFromCurrent(
      id,
      async (current) => {
        const edit = await this.buildEdit(current, params);
        changes = edit.changes;
        return edit.body;
      },
      params.lockVersion,
    );
    return { workPackage: map.mapWorkPackageSummary(updated, this.baseUrl), changes, lockVersion: lockVersionOf(updated) };
  }

  /** The before/after an edit would produce, without writing (for dryRun previews). */
  async previewWorkPackageEdit(id: number | string, params: UpdateWorkPackageParams): Promise<WorkPackageEditPreview> {
    const current = await this.http.get<HalResource>(`/work_packages/${id}`);
    const lockVersion = lockVersionOf(current);
    if (params.lockVersion !== undefined) assertLockVersionFresh(id, params.lockVersion, lockVersion);
    const { changes } = await this.buildEdit(current, params);
    return { workPackageId: Number(id), lockVersion, changes };
  }

  /** Change status by name or id; verifies the transition is permitted first. */
  async updateStatus(id: number | string, statusNameOrId: string | number): Promise<WorkPackageSummaryDTO> {
    const statusId = await this.resolveStatusId(statusNameOrId);
    const allowed = await this.getAllowedStatusTransitions(id);
    if (allowed.length > 0 && !allowed.some((s) => s.id === statusId)) {
      throw new UnprocessableError(
        `Status transition to '${statusNameOrId}' (id ${statusId}) is not permitted for work package ${id}. ` +
          `Allowed: ${allowed.map((s) => s.name).join(', ') || '(none)'}`,
        422,
      );
    }
    return this.updateWorkPackage(id, { _links: { status: { href: `/api/v3/statuses/${statusId}` } } });
  }

  async assign(id: number | string, userIdOrMe: string): Promise<WorkPackageSummaryDTO> {
    const userId = await this.resolveAssigneeId(userIdOrMe);
    return this.updateWorkPackage(id, { _links: { assignee: { href: `/api/v3/users/${userId}` } } });
  }

  /** Create a work package in a project. Resolves type/priority names and "me". */
  async createWorkPackage(
    projectId: string | number,
    params: CreateWorkPackageParams,
  ): Promise<WorkPackageSummaryDTO> {
    const typeId = (await this.resolveTypeIds([params.type]))[0];
    const links: Record<string, { href: string }> = {
      type: { href: `/api/v3/types/${typeId}` },
    };
    if (params.assignee) {
      links['assignee'] = { href: `/api/v3/users/${await this.resolveAssigneeId(params.assignee)}` };
    }
    if (params.priority) {
      links['priority'] = { href: `/api/v3/priorities/${(await this.resolvePriorityIds([params.priority]))[0]}` };
    }
    if (params.parentId != null) {
      links['parent'] = { href: `/api/v3/work_packages/${params.parentId}` };
    }
    const body: Record<string, unknown> = { subject: params.subject, _links: links };
    if (params.description) body['description'] = { format: 'markdown', raw: params.description };
    const created = await this.http.post<HalResource>(
      `/projects/${encodeURIComponent(String(projectId))}/work_packages`,
      body,
    );
    return map.mapWorkPackageSummary(created, this.baseUrl);
  }

  /** Log time against a work package (optional feature; /time_entries). */
  async logTime(id: number | string, hours: number, comment?: string): Promise<void> {
    const body: Record<string, unknown> = {
      hours: hoursToIso8601(hours),
      spentOn: new Date().toISOString().slice(0, 10),
      _links: { workPackage: { href: `/api/v3/work_packages/${id}` } },
    };
    if (comment) body['comment'] = { raw: comment };
    await this.http.post('/time_entries', body);
  }
}
