/**
 * `openproject-mcp --doctor` — standalone self-test so "Failed to connect" is
 * diagnosable without reading source code. Prints (to stderr-safe stdout, since
 * doctor mode never speaks MCP): env status (masked), .env search results, and
 * a live API round-trip. Exits non-zero with a one-line fix hint on failure.
 */
import { OpenProjectClient, OpenProjectError } from '@openproject-agent/core';
import { applyEnvFallback, maskValue, type EnvFallbackResult } from './env.js';
import { DEFAULT_PROTECTED_TRANSITIONS, DEFAULT_START_STATUS } from './config.js';

export interface DoctorIO {
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  clientFactory?: (url: string, apiKey: string) => Pick<OpenProjectClient, 'getCurrentUser' | 'listProjects'>;
}

function hint(line: string): string {
  return `  ➜ Fix: ${line}`;
}

export async function runDoctor(io: DoctorIO): Promise<number> {
  const { log, env } = io;
  log('openproject-mcp doctor');
  log('======================');

  // 1. env + .env fallback
  const fallback: EnvFallbackResult = applyEnvFallback(env);
  log('');
  log('.env search order:');
  for (const p of fallback.searched) log(`  - ${p}${fallback.loadedFrom === p ? '   <-- loaded' : ''}`);
  if (fallback.appliedKeys.length) log(`Applied from .env: ${fallback.appliedKeys.join(', ')}`);

  const url = env.OPENPROJECT_URL?.trim();
  const apiKey = env.OPENPROJECT_API_KEY?.trim();
  log('');
  log(`OPENPROJECT_URL                   = ${url ?? '<not set>'}`);
  log(`OPENPROJECT_API_KEY               = ${maskValue(apiKey)}`);
  log(`OPENPROJECT_READONLY              = ${env.OPENPROJECT_READONLY ?? '<not set> (writes enabled)'}`);
  log(`OPENPROJECT_PROTECTED_TRANSITIONS = ${env.OPENPROJECT_PROTECTED_TRANSITIONS ?? `<not set> (default: ${DEFAULT_PROTECTED_TRANSITIONS.join(',')})`}`);
  log(`OPENPROJECT_START_STATUS          = ${env.OPENPROJECT_START_STATUS ?? `<not set> (default: ${DEFAULT_START_STATUS})`}`);

  if (!url) {
    log('');
    log('✗ OPENPROJECT_URL is missing.');
    log(hint('set OPENPROJECT_URL (e.g. https://openproject.example.com) in the registration env or a .env file listed above.'));
    return 1;
  }
  if (!apiKey) {
    log('');
    log('✗ OPENPROJECT_API_KEY is missing.');
    log(hint('set OPENPROJECT_API_KEY (OpenProject -> My account -> Access tokens -> API) in the registration env or a .env file listed above.'));
    return 1;
  }

  // 2. live round-trip
  log('');
  log(`Connecting to ${url} ...`);
  const client = (io.clientFactory ?? ((u, k) => new OpenProjectClient({ url: u, apiKey: k })))(url, apiKey);
  try {
    const me = await client.getCurrentUser();
    log(`✓ auth OK — logged in as: ${me.name} (id ${me.id})`);
  } catch (err) {
    log(`✗ auth FAILED: ${(err as Error).message}`);
    if (err instanceof OpenProjectError && (err.status === 401 || err.status === 403)) {
      log(hint('the API key is wrong or revoked. Generate a new one: OpenProject -> My account -> Access tokens.'));
    } else {
      log(hint('check the URL is reachable from this machine (VPN/proxy?) and uses the correct scheme/host.'));
    }
    return 2;
  }
  try {
    const projects = await client.listProjects();
    log(`✓ API OK — ${projects.length} project(s) visible: ${projects.slice(0, 5).map((p) => p.identifier).join(', ')}${projects.length > 5 ? ', …' : ''}`);
  } catch (err) {
    log(`✗ project listing FAILED: ${(err as Error).message}`);
    log(hint('the key authenticates but cannot list projects — check the account’s permissions in OpenProject.'));
    return 2;
  }

  log('');
  log('All checks passed. If Claude Code still shows "Failed to connect":');
  log('  1. Make sure you registered with the SAME env you just tested.');
  log('  2. Start a NEW Claude Code session — MCP tools load at session start.');
  log('  3. Run `claude mcp list` INSIDE the target project directory.');
  return 0;
}
