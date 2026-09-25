/** Prompt rendering: fill templates/work-package.md with work-package context. */
import type { WorkPackageDetailDTO } from '@openproject-agent/core';

const BUG_GUIDANCE =
  'This is a BUG. Work in this order: (1) reproduce and analyze the root cause before touching code, ' +
  '(2) apply the minimal fix, (3) add a regression test that fails without the fix.';

const FEATURE_GUIDANCE =
  'This is a FEATURE. Work in this order: (1) study existing patterns and conventions in the repo, ' +
  '(2) implement consistently with them, (3) add tests covering the new behavior.';

const GENERIC_GUIDANCE =
  'Analyze the task, inspect the repo for relevant patterns first, implement the smallest correct change, and add or update tests.';

export function typeGuidance(type: string | null): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('bug')) return BUG_GUIDANCE;
  if (t.includes('feature')) return FEATURE_GUIDANCE;
  return GENERIC_GUIDANCE;
}

/**
 * Wrap text written by OpenProject users in <untrusted-content> tags so the
 * template can tell the agent to treat it as data. Look-alike fence tags inside
 * the text (spacing, case, separators) are escaped so they do not read as the
 * real closing tag. This is a prompt-level mitigation, not a hard boundary.
 */
export function fenceUntrusted(text: string): string {
  const neutralized = text.replace(/<(\s*\/?\s*untrusted[\W_]*content)/gi, '&lt;$1');
  return neutralized.includes('\n')
    ? `<untrusted-content>\n${neutralized}\n</untrusted-content>`
    : `<untrusted-content>${neutralized}</untrusted-content>`;
}

/** Replace {{key}} placeholders. Unknown placeholders are left intact so typos are visible. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}

function formatRelations(wp: WorkPackageDetailDTO): string {
  if (wp.relations.length === 0) return '(none)';
  return fenceUntrusted(
    wp.relations.map((r) => `- ${r.type} #${r.targetId ?? '?'}${r.targetSubject ? `: ${r.targetSubject}` : ''}`).join('\n'),
  );
}

function formatComments(wp: WorkPackageDetailDTO): string {
  if (wp.comments.length === 0) return '(none)';
  return fenceUntrusted(
    wp.comments
      .slice(-10)
      .map((c) => `- ${c.author ?? 'unknown'}${c.createdAt ? ` (${c.createdAt})` : ''}: ${c.comment}`)
      .join('\n'),
  );
}

function formatAttachments(wp: WorkPackageDetailDTO): string {
  if (wp.attachments.length === 0) return '(none)';
  return fenceUntrusted(
    wp.attachments.map((a) => `- #${a.id} ${a.fileName}${a.contentType ? ` (${a.contentType})` : ''}`).join('\n'),
  );
}

export function buildPromptVariables(
  wp: WorkPackageDetailDTO,
  opts: { targetRepo: string },
): Record<string, string> {
  return {
    id: String(wp.id),
    type: wp.type ?? 'Unknown',
    subject: fenceUntrusted(wp.subject),
    status: wp.status ?? 'Unknown',
    priority: wp.priority ?? 'Unknown',
    assignee: wp.assignee ? fenceUntrusted(wp.assignee) : 'Unassigned',
    url: wp.url,
    description: wp.description?.trim() ? fenceUntrusted(wp.description) : '(no description provided)',
    relations: formatRelations(wp),
    comments: formatComments(wp),
    attachments: formatAttachments(wp),
    typeGuidance: typeGuidance(wp.type),
    targetRepo: opts.targetRepo,
  };
}

export function renderWorkPackagePrompt(
  template: string,
  wp: WorkPackageDetailDTO,
  opts: { targetRepo: string },
): string {
  return renderTemplate(template, buildPromptVariables(wp, opts));
}
