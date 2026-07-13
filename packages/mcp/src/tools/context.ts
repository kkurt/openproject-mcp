/** Shared context and result helpers for MCP tools. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OpenProjectClient } from '@openproject-agent/core';

export interface ToolContext {
  client: OpenProjectClient;
  /** Global read-only mode: block real writes (previews still allowed). */
  readOnly: boolean;
  /** Status names that always require human approval. */
  protectedTransitions: string[];
  /** Status that start_work_package transitions a work package to. */
  startStatus: string;
}

/** Wrap a DTO as a compact JSON text result. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** A plain-text result. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** An image result (base64 data) the model can view, with an optional caption. */
export function imageResult(base64: string, mimeType: string, caption?: string): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'image', data: base64, mimeType }];
  if (caption) content.unshift({ type: 'text', text: caption });
  return { content };
}

/** An error result the model can read and react to. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function isProtectedTransition(protectedTransitions: string[], statusName: string): boolean {
  return protectedTransitions.some((p) => p.toLowerCase() === statusName.toLowerCase());
}
