/**
 * HAL+JSON -> compact DTO mappers. Each mapper strips `_links`/`_embedded` noise
 * and resolves link titles / hrefs into flat fields.
 */
import type {
  ActivityDTO,
  AttachmentDTO,
  CommentDTO,
  EditableWorkPackageFields,
  Formattable,
  HalLink,
  HalResource,
  PriorityDTO,
  ProjectDTO,
  RelationDTO,
  SchemaFieldDTO,
  StatusDTO,
  TypeDTO,
  UserDTO,
  ValidationErrorDTO,
  WorkPackageDetailDTO,
  WorkPackageSchemaDTO,
  WorkPackageSummaryDTO,
} from './types.js';

// --- link helpers -----------------------------------------------------------

function singleLink(res: HalResource, key: string): HalLink | undefined {
  const link = res._links?.[key];
  if (Array.isArray(link)) return link[0];
  return link ?? undefined;
}

function linkTitle(res: HalResource, key: string): string | null {
  return singleLink(res, key)?.title ?? null;
}

function linkHref(res: HalResource, key: string): string | null {
  return singleLink(res, key)?.href ?? null;
}

/** Extract the trailing numeric id from a HAL href like `/api/v3/statuses/7`. */
export function idFromHref(href: string | null | undefined): number | null {
  if (!href) return null;
  const match = /\/(\d+)(?:\/[^/]*)?\/?$/.exec(href);
  return match ? Number(match[1]) : null;
}

function absolutize(baseUrl: string, href: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
}

function raw(value: unknown): string | null {
  if (value && typeof value === 'object' && 'raw' in (value as object)) {
    return (value as Formattable).raw ?? null;
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const ISO_DURATION =
  /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Convert an ISO-8601 duration (e.g. "PT1H30M", "P1DT2H") to decimal hours; a day counts as 24h. */
export function iso8601ToHours(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DURATION.exec(value);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return Math.round((days * 24 + hours + minutes / 60 + seconds / 3600) * 10_000) / 10_000;
}

export function workPackageWebUrl(baseUrl: string, id: number): string {
  return `${baseUrl}/work_packages/${id}`;
}

// --- resource mappers -------------------------------------------------------

export function mapProject(hal: HalResource, baseUrl: string): ProjectDTO {
  const id = hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0;
  return {
    id,
    identifier: str(hal['identifier']) ?? '',
    name: str(hal['name']) ?? '',
    active: typeof hal['active'] === 'boolean' ? (hal['active'] as boolean) : null,
    description: raw(hal['description']),
    url: `${baseUrl}/projects/${str(hal['identifier']) ?? id}`,
  };
}

export function mapWorkPackageSummary(hal: HalResource, baseUrl: string): WorkPackageSummaryDTO {
  const id = hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0;
  return {
    id,
    type: linkTitle(hal, 'type'),
    subject: str(hal['subject']) ?? '',
    status: linkTitle(hal, 'status'),
    priority: linkTitle(hal, 'priority'),
    assignee: linkTitle(hal, 'assignee'),
    updatedAt: str(hal['updatedAt']),
    url: workPackageWebUrl(baseUrl, id),
  };
}

export function mapEditableFields(hal: HalResource): EditableWorkPackageFields {
  return {
    subject: str(hal['subject']) ?? '',
    description: raw(hal['description']) ?? '',
    startDate: str(hal['startDate']),
    dueDate: str(hal['dueDate']),
    estimatedHours: iso8601ToHours(hal['estimatedTime']),
    percentageDone: num(hal['percentageDone']),
    priority: linkTitle(hal, 'priority'),
    assignee: linkTitle(hal, 'assignee'),
    responsible: linkTitle(hal, 'responsible'),
    parentId: idFromHref(linkHref(hal, 'parent')),
  };
}

export function mapComment(hal: HalResource): CommentDTO {
  return {
    id: hal.id ?? 0,
    author: linkTitle(hal, 'user'),
    comment: raw(hal['comment']) ?? '',
    createdAt: str(hal['createdAt']),
  };
}

export function mapActivity(hal: HalResource): ActivityDTO {
  const comment = raw(hal['comment']) ?? '';
  const details = Array.isArray(hal['details'])
    ? (hal['details'] as unknown[]).map((d) => raw(d) ?? '').filter(Boolean)
    : [];
  return {
    id: hal.id ?? 0,
    kind: comment.trim() ? 'comment' : 'change',
    author: linkTitle(hal, 'user'),
    authorId: idFromHref(linkHref(hal, 'user')),
    comment,
    details,
    version: num(hal['version']),
    internal: typeof hal['internal'] === 'boolean' ? (hal['internal'] as boolean) : null,
    createdAt: str(hal['createdAt']),
  };
}

/** Map a raw schema resource into a compact field list (skips meta keys). */
export function mapWorkPackageSchema(hal: HalResource): WorkPackageSchemaDTO {
  const id = schemaIdFromHref(linkHref(hal, 'self'));
  const fields: SchemaFieldDTO[] = [];
  for (const [key, value] of Object.entries(hal)) {
    if (key.startsWith('_') || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (typeof v['type'] !== 'string') continue;
    fields.push({
      key,
      name: str(v['name']) ?? key,
      type: v['type'] as string,
      required: v['required'] === true,
      writable: v['writable'] === true,
    });
  }
  return {
    id,
    fields,
    customFields: fields.filter((f) => /^customField\d+$/.test(f.key)),
  };
}

/** Extract "6-7" from /api/v3/work_packages/schemas/6-7 (ids there are not purely numeric). */
function schemaIdFromHref(href: string | null): string {
  if (!href) return '';
  const match = /\/schemas\/([^/]+)\/?$/.exec(href);
  return match?.[1] ?? '';
}

export function mapRelation(hal: HalResource, currentWorkPackageId: number): RelationDTO {
  const fromHref = linkHref(hal, 'from');
  const fromId = idFromHref(fromHref);
  const otherKey = fromId === currentWorkPackageId ? 'to' : 'from';
  const other = singleLink(hal, otherKey);
  return {
    id: hal.id ?? 0,
    type: str(hal['type']) ?? 'relates',
    targetId: idFromHref(other?.href),
    targetSubject: other?.title ?? null,
    description: str(hal['description']),
  };
}

export function mapAttachment(hal: HalResource, baseUrl: string): AttachmentDTO {
  const download = linkHref(hal, 'downloadLocation') ?? linkHref(hal, 'staticDownloadLocation');
  return {
    id: hal.id ?? 0,
    fileName: str(hal['fileName']) ?? '',
    fileSize: num(hal['fileSize']),
    contentType: str(hal['contentType']),
    downloadUrl: absolutize(baseUrl, download),
  };
}

export function mapStatus(hal: HalResource): StatusDTO {
  return {
    id: hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0,
    name: str(hal['name']) ?? '',
    isClosed: typeof hal['isClosed'] === 'boolean' ? (hal['isClosed'] as boolean) : null,
  };
}

export function mapType(hal: HalResource): TypeDTO {
  return { id: hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0, name: str(hal['name']) ?? '' };
}

export function mapPriority(hal: HalResource): PriorityDTO {
  return { id: hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0, name: str(hal['name']) ?? '' };
}

export function mapUser(hal: HalResource): UserDTO {
  return {
    id: hal.id ?? idFromHref(linkHref(hal, 'self')) ?? 0,
    name: str(hal['name']) ?? '',
    login: str(hal['login']),
    email: str(hal['email']),
  };
}

// --- work package detail assembly ------------------------------------------

/** Custom field values keyed by `customField<N>`; link fields map to titles (an array for multi-select). */
export function collectCustomFields(hal: HalResource): Record<string, unknown> {
  const custom: Record<string, unknown> = {};
  const re = /^customField\d+$/;
  for (const [key, value] of Object.entries(hal)) {
    if (re.test(key)) custom[key] = raw(value) ?? value;
  }
  if (hal._links) {
    for (const [key, value] of Object.entries(hal._links)) {
      if (!re.test(key) || !value) continue;
      custom[key] = Array.isArray(value) ? value.map((l) => l.title ?? l.href) : (value.title ?? value.href);
    }
  }
  return custom;
}

/** Flatten a form's `validationErrors` (one Error or MultipleErrors per attribute) to one entry per message. */
export function mapValidationErrors(form: HalResource): ValidationErrorDTO[] {
  const byField = (form._embedded?.['validationErrors'] ?? {}) as Record<string, HalResource>;
  const out: ValidationErrorDTO[] = [];
  for (const [field, error] of Object.entries(byField)) {
    const nested = error._embedded?.['errors'];
    for (const e of Array.isArray(nested) ? (nested as HalResource[]) : [error]) {
      out.push({ field, message: str(e['message']) ?? 'Invalid value' });
    }
  }
  return out;
}

function parentChildRelations(hal: HalResource): RelationDTO[] {
  const relations: RelationDTO[] = [];
  const parent = singleLink(hal, 'parent');
  if (parent?.href) {
    relations.push({
      id: 0,
      type: 'parent',
      targetId: idFromHref(parent.href),
      targetSubject: parent.title ?? null,
      description: null,
    });
  }
  const children = hal._links?.['children'];
  if (Array.isArray(children)) {
    for (const child of children) {
      relations.push({
        id: 0,
        type: 'child',
        targetId: idFromHref(child.href),
        targetSubject: child.title ?? null,
        description: null,
      });
    }
  }
  return relations;
}

export interface WorkPackageDetailParts {
  comments: CommentDTO[];
  relations: RelationDTO[];
  attachments: AttachmentDTO[];
}

export function mapWorkPackageDetail(
  hal: HalResource,
  parts: WorkPackageDetailParts,
  baseUrl: string,
): WorkPackageDetailDTO {
  const summary = mapWorkPackageSummary(hal, baseUrl);
  const projectHref = linkHref(hal, 'project');
  return {
    ...summary,
    description: raw(hal['description']),
    project: projectHref
      ? { id: idFromHref(projectHref), name: linkTitle(hal, 'project') }
      : null,
    author: linkTitle(hal, 'author'),
    createdAt: str(hal['createdAt']),
    startDate: str(hal['startDate']),
    dueDate: str(hal['dueDate']),
    estimatedHours: iso8601ToHours(hal['estimatedTime']),
    percentageDone: num(hal['percentageDone']),
    lockVersion: num(hal['lockVersion']) ?? 0,
    customFields: collectCustomFields(hal),
    comments: parts.comments,
    relations: [...parentChildRelations(hal), ...parts.relations],
    attachments: parts.attachments,
  };
}
