/**
 * Orchestrator configuration: loads openproject-agent.config.json, resolves
 * `env:VAR` references against the environment, and validates with zod.
 * Secrets are resolved into memory but must never be logged (see redact()).
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const SortPair = z.tuple([z.string(), z.enum(['asc', 'desc'])]);

export const ConfigSchema = z.object({
  openproject: z.object({
    url: z.string().url(),
    apiKey: z.string().min(1),
  }),
  project: z.string().min(1),
  targetRepo: z.string().min(1),
  filters: z
    .object({
      types: z.array(z.string()).optional(),
      statuses: z.array(z.string()).optional(),
      assignee: z.string().optional(),
      priority: z.array(z.string()).optional(),
    })
    .default({}),
  /** When set, the queue is built from a board column instead of filters.statuses. */
  board: z
    .object({
      name: z.string().min(1),
      /** Column to pull from; defaults to the leftmost column. */
      sourceColumn: z.string().optional(),
    })
    .optional(),
  order: z.array(SortPair).default([
    ['priority', 'desc'],
    ['id', 'asc'],
  ]),
  statusFlow: z.object({
    start: z.string().min(1),
    success: z.string().min(1),
    blocked: z.string().min(1),
  }),
  protectedTransitions: z.array(z.string()).default(['Closed', 'Rejected']),
  write: z.boolean().default(false),
  /** Markdown appended to every result comment below a `---` rule; "" omits it. */
  commentFooter: z.string().optional(),
  claude: z
    .object({
      binPath: z.string().default('claude'),
      maxTurns: z.number().int().positive().default(40),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().default(30 * 60 * 1000),
      allowedTools: z
        .array(z.string())
        .default(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(npm test:*)', 'mcp__openproject']),
      disallowedTools: z.array(z.string()).default(['Bash(git:*)']),
      addDirs: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Recursively replace any string of the form "env:VAR" with process.env.VAR. */
export function resolveEnvRefs(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    const match = /^env:(.+)$/.exec(value);
    if (match) {
      const key = match[1]!;
      const resolved = env[key];
      if (resolved === undefined || resolved === '') {
        throw new Error(`Config references env:${key} but ${key} is not set`);
      }
      return resolved;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvRefs(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v, env)]));
  }
  return value;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

/** Read + resolve + validate a config file. Also honors OPENPROJECT_URL/API_KEY env overrides. */
export async function loadConfig(configPath: string, options: LoadConfigOptions = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  let rawText: string;
  try {
    rawText = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read config file '${configPath}': ${(err as Error).message}`);
  }
  const parsedJson = JSON.parse(rawText) as Record<string, unknown>;
  const resolved = resolveEnvRefs(parsedJson, env) as Record<string, unknown>;
  const config = ConfigSchema.parse(resolved);

  // Direct env overrides win over file values.
  if (env.OPENPROJECT_URL) config.openproject.url = env.OPENPROJECT_URL;
  if (env.OPENPROJECT_API_KEY) config.openproject.apiKey = env.OPENPROJECT_API_KEY;

  return config;
}

/** Mask the API key (and any exact secret) in an arbitrary string for safe logging. */
export function maskSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

/** A config copy safe to log/serialize (apiKey masked). */
export function redact(config: AppConfig): AppConfig {
  return {
    ...config,
    openproject: { ...config.openproject, apiKey: '***' },
  };
}
