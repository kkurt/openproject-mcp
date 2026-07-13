import { describe, expect, it } from 'vitest';
import { extractJsonObjects, parseReport } from '@openproject-agent/orchestrator';

describe('extractJsonObjects', () => {
  it('extracts multiple top-level objects and ignores braces in strings', () => {
    const objs = extractJsonObjects('{"a":"has } and { inside"} noise {"b":2}');
    expect(objs).toEqual([{ a: 'has } and { inside' }, { b: 2 }]);
  });
});

describe('parseReport', () => {
  it('parses a fenced result block', () => {
    const out = 'preamble\n```json\n{"result":"done","summary":"fixed","changedFiles":["a.ts"],"openQuestions":[],"testsRun":"npm test"}\n```\n';
    expect(parseReport(out)).toMatchObject({
      result: 'done',
      summary: 'fixed',
      changedFiles: ['a.ts'],
      testsRun: 'npm test',
      matchedBlock: true,
    });
  });

  it('picks the last object that has a result field', () => {
    const out = '{"result":"blocked","summary":"first"} then {"other":1} then {"result":"failed","summary":"second"}';
    expect(parseReport(out)).toMatchObject({ result: 'failed', summary: 'second' });
  });

  it('handles braces embedded in string values', () => {
    expect(parseReport('{"result":"done","summary":"has } brace and { in text"}')).toMatchObject({
      result: 'done',
      summary: 'has } brace and { in text',
    });
  });

  it('falls back to unknown when there is no block', () => {
    const r = parseReport('just prose, no json at all');
    expect(r.result).toBe('unknown');
    expect(r.matchedBlock).toBe(false);
    expect(r.summary).toContain('just prose');
  });

  it('normalizes unexpected result values to unknown', () => {
    expect(parseReport('{"result":"weird","summary":"x"}').result).toBe('unknown');
  });
});
