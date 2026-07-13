/** Assembles the OpenProject MCP server (stdio transport wired separately in bin.ts). */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import type { ToolContext } from './tools/context.js';

export const SERVER_NAME = 'openproject-mcp';
export const SERVER_VERSION = '0.1.0';

/** Create a fully-wired McpServer given an OpenProject client + safety settings. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
