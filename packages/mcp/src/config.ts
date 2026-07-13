/** MCP server configuration, loaded from environment variables. */

export interface McpConfig {
  url: string;
  apiKey: string;
  /** When true, write tools refuse to mutate (dryRun previews are still allowed). */
  readOnly: boolean;
  /** Status names whose transitions always require human approval (case-insensitive). */
  protectedTransitions: string[];
}

export const DEFAULT_PROTECTED_TRANSITIONS = ['Closed', 'Rejected'];

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Build config from environment; throws if required values are missing. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const url = env.OPENPROJECT_URL?.trim();
  const apiKey = env.OPENPROJECT_API_KEY?.trim();
  if (!url) throw new Error('OPENPROJECT_URL environment variable is required');
  if (!apiKey) throw new Error('OPENPROJECT_API_KEY environment variable is required');

  const protectedRaw = env.OPENPROJECT_PROTECTED_TRANSITIONS?.trim();
  const protectedTransitions = protectedRaw
    ? protectedRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_PROTECTED_TRANSITIONS];

  return {
    url,
    apiKey,
    readOnly: parseBool(env.OPENPROJECT_READONLY),
    protectedTransitions,
  };
}
