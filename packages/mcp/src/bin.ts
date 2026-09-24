#!/usr/bin/env node
/**
 * Executable entry.
 *   default      — serve MCP over stdio (env built from process.env + .env fallback)
 *   --doctor     — standalone self-test (env + live API round-trip), never speaks MCP
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenProjectClient } from '@openproject-agent/core';
import { loadConfigFromEnv } from './config.js';
import { runDoctor } from './doctor.js';
import { applyEnvFallback } from './env.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  if (process.argv.includes('--doctor') || process.argv.includes('doctor')) {
    const code = await runDoctor({ log: (l) => console.log(l), env: process.env });
    // Let undici sockets tear down before exiting (avoids a libuv assert on Windows),
    // but don't let lingering keep-alives hold the process open.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 500).unref();
    return;
  }

  // Fill missing OPENPROJECT_* vars from a .env file (cwd -> package -> repo root).
  const fallback = applyEnvFallback(process.env);
  if (fallback.loadedFrom) {
    console.error(`[openproject-mcp] filled ${fallback.appliedKeys.join(', ')} from ${fallback.loadedFrom}`);
  }

  const config = loadConfigFromEnv();
  const client = new OpenProjectClient({ url: config.url, apiKey: config.apiKey });
  const server = createServer({
    client,
    readOnly: config.readOnly,
    protectedTransitions: config.protectedTransitions,
    startStatus: config.startStatus,
  });
  await server.connect(new StdioServerTransport());
  // stdout is reserved for the MCP protocol; all logs go to stderr.
  console.error(
    `[openproject-mcp] connected (url=${config.url}, readOnly=${config.readOnly}, protected=[${config.protectedTransitions.join(', ')}], startStatus=${config.startStatus})`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[openproject-mcp] fatal: ${message}`);
  console.error('[openproject-mcp] hint: run `node <this bin.js> --doctor` in a terminal to diagnose (env vars, .env lookup, live API check).');
  process.exit(1);
});
