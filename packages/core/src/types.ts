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
