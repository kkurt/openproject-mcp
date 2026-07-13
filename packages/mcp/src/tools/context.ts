/** Shared context and result helpers for MCP tools. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OpenProjectClient } from '@openproject-agent/core';

export interface ToolContext {
  client: OpenProjectClient;
  /** Global read-only mode: block real writes (previews still allowed). */
  readOnly: boolean;
  /** Status names that always require human approval. */
  protectedTransitions: string[];
}

/** Wrap a DTO as a compact JSON text result. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** An error result the model can read and react to. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function isProtectedTransition(protectedTransitions: string[], statusName: string): boolean {
  return protectedTransitions.some((p) => p.toLowerCase() === statusName.toLowerCase());
}
