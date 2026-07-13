import { describe, expect, it } from 'vitest';
import { buildMcpConfig } from '@openproject-agent/orchestrator';

describe('buildMcpConfig', () => {
  it('wires the server command, args and env (readOnly mirrors dry-run)', () => {
    const cfg = buildMcpConfig({
      serverPath: '/x/dist/bin.js',
      url: 'https://op.test',
      apiKey: 'secret',
      readOnly: true,
      protectedTransitions: ['Closed', 'Rejected'],
      nodePath: '/usr/bin/node',
    });
    expect(cfg.mcpServers.openproject.command).toBe('/usr/bin/node');
    expect(cfg.mcpServers.openproject.args).toEqual(['/x/dist/bin.js']);
    expect(cfg.mcpServers.openproject.env).toEqual({
      OPENPROJECT_URL: 'https://op.test',
      OPENPROJECT_API_KEY: 'secret',
      OPENPROJECT_READONLY: 'true',
      OPENPROJECT_PROTECTED_TRANSITIONS: 'Closed,Rejected',
    });
  });
});
