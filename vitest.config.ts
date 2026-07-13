import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TS source so tests run without a prior build.
const alias = {
  '@openproject-agent/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  '@openproject-agent/mcp': fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url)),
  '@openproject-agent/orchestrator': fileURLToPath(
    new URL('./packages/orchestrator/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
