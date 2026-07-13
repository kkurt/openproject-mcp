#!/usr/bin/env node
/** Executable entry: build the client from env and serve over stdio. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenProjectClient } from '@openproject-agent/core';
import { loadConfigFromEnv } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
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
    `[openproject-mcp] connected (readOnly=${config.readOnly}, protected=[${config.protectedTransitions.join(', ')}])`,
  );
}

main().catch((err: unknown) => {
  console.error('[openproject-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
