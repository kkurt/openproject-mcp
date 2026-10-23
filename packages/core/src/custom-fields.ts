/**
 * Resolve friendly custom-field input (`{ Related: ["MetaSync"] }`) against a
 * work-package form schema into PATCH properties and links. The form schema is
 * the source because only it embeds `allowedValues` for list fields; the plain
 * schema endpoint leaves them out.
 */
import { NotFoundError, UnprocessableError } from './errors.js';
import { collectCustomFields, idFromHref } from './map.js';
import type { CustomFieldChange, CustomFieldInput, HalLink, HalResource } from './types.js';

export interface CustomFieldPatch {
  props: Record<string, unknown>;
  links: Record<string, { href: string | null } | Array<{ href: string }>>;
  changes: Record<string, CustomFieldChange>;
}

interface CustomFieldSchema {
  key: string;
  name: string;
  /** e.g. "String", "Formattable", "CustomOption", "[]CustomOption", "User". */
  type: string;
  writable: boolean;
  isLink: boolean;
  /** Allowed link targets when the form embeds them (list fields), else null. */
  allowed: HalLink[] | null;
}

/** Link targets addressable by numeric id when the form embeds no allowedValues. */
const HREF_BASE: Record<string, string> = {
  CustomOption: '/api/v3/custom_options',
  User: '/api/v3/users',
  Version: '/api/v3/versions',
};

function customFieldSchemas(schema: Record<string, unknown>): CustomFieldSchema[] {
  const fields: CustomFieldSchema[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!/^customField\d+$/.test(key) || !value || typeof value !== 'object') continue;
    const v = value as HalResource;
    const allowed = v._links?.['allowedValues'];
    fields.push({
      key,
      name: typeof v['name'] === 'string' ? v['name'] : key,
      type: typeof v['type'] === 'string' ? v['type'] : 'String',
      writable: v['writable'] === true,
      isLink: v['location'] === '_links',
      allowed: Array.isArray(allowed) ? allowed : null,
    });
  }
  return fields;
}

function findField(fields: CustomFieldSchema[], keyOrName: string): CustomFieldSchema {
  const byKey = fields.find((f) => f.key === keyOrName);
  if (byKey) return byKey;
  const byName = fields.filter((f) => f.name.toLowerCase() === keyOrName.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  const known = fields.map((f) => `${f.name} (${f.key})`).join(', ') || '(none)';
  if (byName.length > 1) {
    throw new UnprocessableError(`Custom field name '${keyOrName}' is ambiguous; use the key. Known: ${known}`, 422);
  }
  throw new NotFoundError(`Unknown custom field '${keyOrName}'. Known: ${known}`, 404);
}

export interface CustomFieldDeps {
  /** Resolve "me" / a numeric id to a user id. */
  resolveUserId(value: string): Promise<number>;
}

async function resolveLink(
  field: CustomFieldSchema,
  item: string | number | boolean,
  deps: CustomFieldDeps,
): Promise<{ href: string; title: string }> {
  const text = String(item);
  if (field.allowed) {
    const found = field.allowed.find(
      (a) => a.title?.toLowerCase() === text.toLowerCase() || (/^\d+$/.test(text) && idFromHref(a.href) === Number(text)),
    );
    if (!found?.href) {
      const titles = field.allowed.map((a) => a.title ?? a.href).join(', ') || '(none)';
      throw new UnprocessableError(`'${text}' is not an allowed value for custom field '${field.name}'. Allowed: ${titles}`, 422);
    }
    return { href: found.href, title: found.title ?? text };
  }
  const baseType = field.type.replace(/^\[\]/, '');
  if (baseType === 'User') return { href: `${HREF_BASE['User']}/${await deps.resolveUserId(text)}`, title: text };
  const base = HREF_BASE[baseType];
  if (base && /^\d+$/.test(text)) return { href: `${base}/${text}`, title: text };
  throw new UnprocessableError(
    `Cannot resolve '${text}' for custom field '${field.name}' (${field.type}); pass a numeric id.`,
    422,
  );
}

/**
 * Build the PATCH parts for custom-field input. Throws before anything is sent
 * for unknown or read-only fields, disallowed options, and extra values.
 */
export async function buildCustomFieldPatch(
  formSchema: Record<string, unknown>,
  current: HalResource,
  input: Record<string, CustomFieldInput>,
  deps: CustomFieldDeps,
): Promise<CustomFieldPatch> {
  const fields = customFieldSchemas(formSchema);
  const currentValues = collectCustomFields(current);
  const patch: CustomFieldPatch = { props: {}, links: {}, changes: {} };

  for (const [keyOrName, value] of Object.entries(input)) {
    const field = findField(fields, keyOrName);
    if (!field.writable) {
      throw new UnprocessableError(`Custom field '${field.name}' (${field.key}) is not writable for this work package.`, 422);
    }
    const multi = field.type.startsWith('[]');
    let to: unknown;

    if (field.isLink) {
      const items = value === null ? [] : Array.isArray(value) ? value : [value];
      if (!multi && items.length > 1) {
        throw new UnprocessableError(`Custom field '${field.name}' takes a single value, got ${items.length}.`, 422);
      }
      const resolved = await Promise.all(items.map((item) => resolveLink(field, item, deps)));
      patch.links[field.key] = multi ? resolved.map((r) => ({ href: r.href })) : { href: resolved[0]?.href ?? null };
      to = multi ? resolved.map((r) => r.title) : (resolved[0]?.title ?? null);
    } else if (Array.isArray(value)) {
      throw new UnprocessableError(`Custom field '${field.name}' takes a single value, got ${value.length}.`, 422);
    } else if (field.type === 'Formattable') {
      if (value !== null && typeof value !== 'string') {
        throw new UnprocessableError(`Custom field '${field.name}' takes markdown text.`, 422);
      }
      patch.props[field.key] = { format: 'markdown', raw: value ?? '' };
      to = value ?? '';
    } else {
      patch.props[field.key] = value;
      to = value;
    }

    patch.changes[field.key] = { name: field.name, from: currentValues[field.key] ?? null, to };
  }
  return patch;
}
