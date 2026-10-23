/**
 * OpenProject HAL+JSON wire types (loosely typed) and the compact DTOs we map them to.
 * DTOs strip HAL noise (`_links`, `_embedded`) into flat, LLM-friendly shapes.
 */

// ---------------------------------------------------------------------------
// Raw HAL wire shapes
// ---------------------------------------------------------------------------

export interface HalLink {
  href: string | null;
  title?: string;
  name?: string;
}

export interface Formattable {
  format: string;
  raw: string;
  html?: string;
}

export interface HalResource {
  _type?: string;
  id?: number;
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  _embedded?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HalCollection<T = HalResource> {
  _type?: string;
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: { elements: T[] };
  _links?: Record<string, HalLink | undefined>;
}

// ---------------------------------------------------------------------------
// Compact DTOs (public surface)
// ---------------------------------------------------------------------------

export interface ProjectDTO {
  id: number;
  identifier: string;
  name: string;
  active: boolean | null;
  description: string | null;
  url: string;
}

export interface WorkPackageSummaryDTO {
  id: number;
  type: string | null;
  subject: string;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  updatedAt: string | null;
  url: string;
}

export interface CommentDTO {
  id: number;
  author: string | null;
  /** Raw markdown/plain comment text. */
  comment: string;
  createdAt: string | null;
}

/** One journal entry (activity), including non-comment change entries. */
export interface ActivityDTO {
  id: number;
  /** 'comment' when the entry carries a user comment, else 'change'. */
  kind: 'comment' | 'change';
  author: string | null;
  authorId: number | null;
  /** Raw comment text ('' for pure change entries). */
  comment: string;
  /** Human-readable change lines, e.g. "Status changed from New to Developed". */
  details: string[];
  version: number | null;
  internal: boolean | null;
  createdAt: string | null;
}

/** Compact work-package form/schema field description. */
export interface SchemaFieldDTO {
  key: string;
  name: string;
  type: string;
  required: boolean;
  writable: boolean;
}

export interface WorkPackageSchemaDTO {
  /** e.g. "6-7" (projectId-typeId). */
  id: string;
  fields: SchemaFieldDTO[];
  /** The subset of fields that are custom fields (customField<N>). */
  customFields: SchemaFieldDTO[];
}

export interface CreateWorkPackageParams {
  /** Type name or id (e.g. "Bug"). */
  type: string;
  subject: string;
  /** Markdown description. */
  description?: string;
  /** "me" or a numeric user id. */
  assignee?: string;
  /** Priority name or id. */
  priority?: string;
  /** Parent work package id. */
  parentId?: number;
}

/** Fields an edit can change. Omitted fields are left as-is; null clears a field. */
export interface UpdateWorkPackageParams {
  subject?: string;
  /** Markdown description; '' clears it. */
  description?: string;
  /** 'replace' (default) overwrites the description; 'append' adds after it, separated by a blank line. */
  descriptionMode?: 'replace' | 'append';
  /** YYYY-MM-DD. */
  startDate?: string | null;
  /** YYYY-MM-DD. */
  dueDate?: string | null;
  /** Decimal hours; sent as the ISO-8601 `estimatedTime`. */
  estimatedHours?: number | null;
  /** 0-100. */
  percentageDone?: number | null;
  /** Priority name or id. */
  priority?: string;
  /** "me" or a numeric user id; null unassigns. */
  assignee?: string | null;
  /** Accountable user: "me" or a numeric user id; null clears. */
  responsible?: string | null;
  /** Parent work package id; null detaches from the parent. */
  parentId?: number | null;
  /**
   * Custom field values keyed by `customField<N>` or display name. List fields take
   * option titles or ids (an array for multi-select); null clears.
   */
  customFields?: Record<string, CustomFieldInput>;
  /**
   * lockVersion of the read this edit is based on. When set, an edit made by
   * someone else since then is reported as a ConflictError instead of overwritten.
   */
  lockVersion?: number;
}

/** Current values of the editable fields, as before/after diffs show them. */
export interface EditableWorkPackageFields {
  subject: string;
  description: string;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
  percentageDone: number | null;
  priority: string | null;
  assignee: string | null;
  responsible: string | null;
  parentId: number | null;
}

export type CustomFieldInput = string | number | boolean | null | Array<string | number>;

export interface CustomFieldChange {
  /** Display name of the custom field. */
  name: string;
  /** Current value; link fields show titles (an array for multi-select). */
  from: unknown;
  to: unknown;
}

/** Before/after values of every field an edit touches. */
export type WorkPackageChanges = {
  [K in keyof EditableWorkPackageFields]?: { from: EditableWorkPackageFields[K]; to: EditableWorkPackageFields[K] };
} & {
  /** Keyed by `customField<N>`. */
  customFields?: Record<string, CustomFieldChange>;
};

/** One server-side validation message from the work-package form. */
export interface ValidationErrorDTO {
  /** API attribute name, e.g. "dueDate" or "customField3". */
  field: string;
  message: string;
}

export interface WorkPackageEditPreview {
  workPackageId: number;
  /** lockVersion the edit would be applied on top of. */
  lockVersion: number;
  changes: WorkPackageChanges;
  /** What OpenProject would reject if the edit were sent; empty when it would be accepted. */
  validationErrors: ValidationErrorDTO[];
}

export interface WorkPackageEditResult {
  workPackage: WorkPackageSummaryDTO;
  changes: WorkPackageChanges;
  /** lockVersion after the edit; pass it to the next edit. */
  lockVersion: number;
}

export interface RelationDTO {
  /** Relation id (0 for parent/child pseudo-relations derived from _links). */
  id: number;
  /** e.g. 'parent', 'child', 'relates', 'blocks', 'blocked', 'duplicates', 'precedes', 'follows'. */
  type: string;
  targetId: number | null;
  targetSubject: string | null;
  description: string | null;
}

export interface AttachmentDTO {
  id: number;
  fileName: string;
  fileSize: number | null;
  contentType: string | null;
  downloadUrl: string | null;
}

export interface WorkPackageDetailDTO extends WorkPackageSummaryDTO {
  /** Raw description text (from `description.raw`). */
  description: string | null;
  project: { id: number | null; name: string | null } | null;
  author: string | null;
  createdAt: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
  percentageDone: number | null;
  /** Needed for any subsequent PATCH; OpenProject rejects updates without it. */
  lockVersion: number;
  customFields: Record<string, unknown>;
  comments: CommentDTO[];
  relations: RelationDTO[];
  attachments: AttachmentDTO[];
}

export interface StatusDTO {
  id: number;
  name: string;
  isClosed: boolean | null;
}

export interface TypeDTO {
  id: number;
  name: string;
}

export interface PriorityDTO {
  id: number;
  name: string;
}

export interface UserDTO {
  id: number;
  name: string;
  login: string | null;
  email: string | null;
}

export interface StatusTransitionDTO {
  id: number;
  name: string;
}

export interface WorkPackageCollectionResult {
  elements: WorkPackageSummaryDTO[];
  total: number;
  count: number;
  pageSize: number;
  offset: number;
}

/** One column of a (status-based) board, backed by a saved query. */
export interface BoardColumnDTO {
  name: string;
  queryId: number;
  /** The status this column filters on, when it is a status-based board column. */
  statusId: number | null;
  /** 1-based left-to-right position. */
  position: number;
}

/** A board (OpenProject stores these as Grids). */
export interface BoardDTO {
  id: number;
  name: string;
  projectIdentifier: string | null;
  columns: BoardColumnDTO[];
}
