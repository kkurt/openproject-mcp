/** Public library API for @openproject-agent/mcp (no side effects — the runnable server is bin.ts). */
export { createServer, exitWhenStdinCloses, SERVER_NAME, SERVER_VERSION } from './server.js';
export { loadConfigFromEnv, DEFAULT_PROTECTED_TRANSITIONS, DEFAULT_START_STATUS, type McpConfig } from './config.js';
export { applyEnvFallback, envFileCandidates, parseEnvFile, maskValue, type EnvFallbackResult } from './env.js';
export { runDoctor, type DoctorIO } from './doctor.js';
export { jsonResult, errorResult, isProtectedTransition, type ToolContext } from './tools/context.js';
export { registerReadTools } from './tools/read.js';
export { registerBoardTools } from './tools/boards.js';
export { registerWriteTools } from './tools/write.js';
