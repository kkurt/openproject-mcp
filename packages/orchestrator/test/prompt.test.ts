import { describe, expect, it } from 'vitest';
import type { WorkPackageDetailDTO } from '@openproject-agent/core';
import { buildPromptVariables, renderTemplate, renderWorkPackagePrompt, typeGuidance } from '@openproject-agent/orchestrator';

const wp: WorkPackageDetailDTO = {
  id: 42,
  type: 'Bug',
  subject: 'Login crash',
  status: 'New',
  priority: 'High',
  assignee: 'Alice',
  updatedAt: null,
  url: 'https://op.test/work_packages/42',
  description: 'repro steps',
  project: null,
  author: null,
  createdAt: null,
  startDate: null,
  dueDate: null,
  estimatedHours: null,
  lockVersion: 1,
  customFields: {},
  comments: [{ id: 1, author: 'Bob', comment: 'seen it too', createdAt: '2024-01-01' }],
  relations: [{ id: 0, type: 'parent', targetId: 40, targetSubject: 'Epic', description: null }],
  attachments: [{ id: 1, fileName: 'log.txt', fileSize: null, contentType: null, downloadUrl: null }],
};

describe('renderTemplate', () => {
  it('replaces known placeholders and leaves unknown ones intact', () => {
    expect(renderTemplate('a {{x}} b {{y}}', { x: '1' })).toBe('a 1 b {{y}}');
  });
});

describe('typeGuidance', () => {
  it('selects guidance by type', () => {
    expect(typeGuidance('Bug')).toMatch(/BUG/);
    expect(typeGuidance('Feature')).toMatch(/FEATURE/);
    expect(typeGuidance('Task')).toMatch(/smallest correct/);
    expect(typeGuidance(null)).toMatch(/smallest correct/);
  });
});

describe('buildPromptVariables', () => {
  it('formats relations, comments, attachments and type guidance', () => {
    const vars = buildPromptVariables(wp, { targetRepo: '/repo' });
    expect(vars.id).toBe('42');
    expect(vars.type).toBe('Bug');
    expect(vars.relations).toContain('parent #40: Epic');
    expect(vars.comments).toContain('Bob');
    expect(vars.attachments).toContain('#1 log.txt');
    expect(vars.typeGuidance).toMatch(/BUG/);
    expect(vars.targetRepo).toBe('/repo');
  });

  it('handles empty description/relations/comments', () => {
    const vars = buildPromptVariables(
      { ...wp, description: '', relations: [], comments: [], attachments: [] },
      { targetRepo: '/repo' },
    );
    expect(vars.description).toContain('no description');
    expect(vars.relations).toBe('(none)');
    expect(vars.comments).toBe('(none)');
    expect(vars.attachments).toBe('(none)');
  });
});

describe('renderWorkPackagePrompt', () => {
  it('fills a template end-to-end', () => {
    const out = renderWorkPackagePrompt('WP {{id}}: {{subject}}\n{{typeGuidance}}\nRepo: {{targetRepo}}', wp, {
      targetRepo: '/repo',
    });
    expect(out).toContain('WP 42: Login crash');
    expect(out).toContain('/repo');
    expect(out).toMatch(/BUG/);
  });
});
