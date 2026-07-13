/** Build the --mcp-config payload that wires our MCP server into spawned Claude Code. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerEntry>;
}

export interface BuildMcpConfigOptions {
  /** Absolute path to the MCP server bin (dist/bin.js). */
  serverPath: string;
  url: string;
  apiKey: string;
  /** Mirrors the orchestrator's dry-run: true blocks all writes from sub-agents. */
  readOnly: boolean;
  protectedTransitions: string[];
  /** Node executable to launch the server with. Defaults to the current node. */
  nodePath?: string;
}

export function buildMcpConfig(opts: BuildMcpConfigOptions): McpConfigFile {
  return {
    mcpServers: {
      openproject: {
        command: opts.nodePath ?? process.execPath,
        args: [opts.serverPath],
        env: {
          OPENPROJECT_URL: opts.url,
          OPENPROJECT_API_KEY: opts.apiKey,
          OPENPROJECT_READONLY: String(opts.readOnly),
          OPENPROJECT_PROTECTED_TRANSITIONS: opts.protectedTransitions.join(','),
        },
      },
    },
  };
}

/** Resolve the built MCP server bin path from the installed @openproject-agent/mcp package. */
export function resolveMcpServerBin(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve('@openproject-agent/mcp');
  return join(dirname(indexPath), 'bin.js');
}
