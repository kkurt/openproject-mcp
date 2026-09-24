/**
 * Minimal .env loading for the MCP server binary.
 *
 * Why: MCP clients silently swallow a server's startup crash, so a registration
 * that forgets OPENPROJECT_API_KEY surfaces only as "Failed to connect". Falling
 * back to a .env file (as the orchestrator already does) makes such registrations
 * work, and means agents never need to read the .env themselves.
 *
 * Search order (first hit wins): $OPENPROJECT_ENV_FILE, ./.env (cwd),
 * <package root>/.env, <repo root>/.env. Existing env vars are NEVER overridden.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse simple KEY=VALUE lines; ignores comments/blank lines; strips matching quotes. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Candidate .env locations for this binary, most specific first. */
export function envFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist (built) or <pkg>/src (tests)
  const pkgRoot = resolve(here, '..');
  const repoRoot = resolve(pkgRoot, '..', '..');
  const candidates: string[] = [];
  if (env.OPENPROJECT_ENV_FILE) candidates.push(resolve(env.OPENPROJECT_ENV_FILE));
  candidates.push(resolve(process.cwd(), '.env'), join(pkgRoot, '.env'), join(repoRoot, '.env'));
  return [...new Set(candidates)];
}

export interface EnvFallbackResult {
  /** Path of the .env that was applied, or null when none was needed/found. */
  loadedFrom: string | null;
  /** Keys that were actually filled in from the file. */
  appliedKeys: string[];
  /** All candidate paths that were considered (for doctor/diagnostics). */
  searched: string[];
}

const REQUIRED = ['OPENPROJECT_URL', 'OPENPROJECT_API_KEY'] as const;

/**
 * If any required variable is missing, load the first existing .env candidate and
 * fill ONLY the missing OPENPROJECT_* variables (never overrides existing values).
 */
export function applyEnvFallback(env: NodeJS.ProcessEnv = process.env): EnvFallbackResult {
  // Escape hatch: disable file lookup entirely (deterministic deployments, tests).
  if (env.OPENPROJECT_NO_ENV_FILE && env.OPENPROJECT_NO_ENV_FILE !== '0') {
    return { loadedFrom: null, appliedKeys: [], searched: [] };
  }
  const searched = envFileCandidates(env);
  const missingRequired = REQUIRED.filter((k) => !env[k]?.trim());
  if (missingRequired.length === 0) return { loadedFrom: null, appliedKeys: [], searched };

  for (const candidate of searched) {
    if (!existsSync(candidate)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(candidate, 'utf8'));
    } catch {
      continue;
    }
    const appliedKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('OPENPROJECT_') && !env[key]?.trim() && value) {
        env[key] = value;
        appliedKeys.push(key);
      }
    }
    if (appliedKeys.length > 0) return { loadedFrom: candidate, appliedKeys, searched };
  }
  return { loadedFrom: null, appliedKeys: [], searched };
}

/** Mask a secret for logs: first 4 chars + length. Never prints the full value. */
export function maskValue(value: string | undefined): string {
  if (!value) return '<not set>';
  return `${value.slice(0, 4)}… (len=${value.length})`;
}
