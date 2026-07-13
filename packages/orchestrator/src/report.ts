/**
 * Parse the agent's structured result block from its final output.
 * The contract (see templates/work-package.md):
 *   {"result":"done|blocked|failed","summary":"...","changedFiles":[...],"openQuestions":[...],"testsRun":"..."}
 * If no valid block is found, result is "unknown" and the orchestrator routes the
 * work package to human review rather than auto-advancing it.
 */

export type AgentResult = 'done' | 'blocked' | 'failed' | 'unknown';

export interface AgentReport {
  result: AgentResult;
  summary: string;
  changedFiles: string[];
  openQuestions: string[];
  testsRun: string;
  /** True when a well-formed result block was found and parsed. */
  matchedBlock: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((s) => s.length > 0);
  return [];
}

function normalizeResult(value: unknown): AgentResult {
  const v = asString(value).toLowerCase();
  return v === 'done' || v === 'blocked' || v === 'failed' ? v : 'unknown';
}

/** Extract every top-level balanced {...} JSON object from text, ignoring braces inside strings. */
export function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(slice) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              objects.push(parsed as Record<string, unknown>);
            }
          } catch {
            // not valid JSON; ignore this candidate
          }
          start = -1;
        }
      }
    }
  }
  return objects;
}

export function parseReport(output: string): AgentReport {
  const candidates = extractJsonObjects(output).filter((o) => 'result' in o);
  const chosen = candidates[candidates.length - 1];
  if (chosen) {
    return {
      result: normalizeResult(chosen['result']),
      summary: asString(chosen['summary']),
      changedFiles: asStringArray(chosen['changedFiles']),
      openQuestions: asStringArray(chosen['openQuestions']),
      testsRun: asString(chosen['testsRun']),
      matchedBlock: true,
    };
  }
  return {
    result: 'unknown',
    summary: output.trim().slice(0, 4000),
    changedFiles: [],
    openQuestions: [],
    testsRun: '',
    matchedBlock: false,
  };
}
