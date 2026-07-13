import { describe, expect, it } from 'vitest';
import {
  idFromHref,
  mapAttachment,
  mapComment,
  mapRelation,
  mapWorkPackageDetail,
  mapWorkPackageSummary,
} from '@openproject-agent/core';
import { activityHal, workPackageHal } from './fixtures.js';

const BASE = 'https://op.test';

describe('idFromHref', () => {
  it('extracts trailing numeric ids', () => {
    expect(idFromHref('/api/v3/statuses/7')).toBe(7);
    expect(idFromHref('/api/v3/work_packages/42')).toBe(42);
    expect(idFromHref('/api/v3/attachments/5/content')).toBe(5);
    expect(idFromHref(null)).toBeNull();
    expect(idFromHref('/api/v3/statuses/none')).toBeNull();
  });
});

describe('mapWorkPackageSummary', () => {
  it('flattens link titles and builds the web url', () => {
    const dto = mapWorkPackageSummary(workPackageHal(), BASE);
    expect(dto).toMatchObject({
      id: 42,
      type: 'Bug',
      subject: 'Fix the login crash',
      status: 'New',
      priority: 'High',
      assignee: 'Alice',
      updatedAt: '2024-01-02T00:00:00Z',
      url: 'https://op.test/work_packages/42',
    });
  });

  it('handles a missing assignee', () => {
    const hal = workPackageHal({ _links: { assignee: { href: null } } });
    expect(mapWorkPackageSummary(hal, BASE).assignee).toBeNull();
  });
});

describe('mapWorkPackageDetail', () => {
  it('extracts raw description, lockVersion, custom fields, and parent relation', () => {
    const hal = workPackageHal({ customField1: { format: 'plain', raw: 'CF value' } });
    const detail = mapWorkPackageDetail(
      hal,
      { comments: [mapComment(activityHal(10, 'a note'))], relations: [], attachments: [] },
      BASE,
    );
    expect(detail.description).toBe('Steps to reproduce...');
    expect(detail.lockVersion).toBe(3);
    expect(detail.project).toEqual({ id: 3, name: 'Demo Project' });
    expect(detail.customFields).toEqual({ customField1: 'CF value' });
    expect(detail.comments).toHaveLength(1);
    // Parent from _links.parent becomes a synthetic relation.
    expect(detail.relations).toContainEqual({
      id: 0,
      type: 'parent',
      targetId: 40,
      targetSubject: 'Epic: Auth',
      description: null,
    });
  });
});

describe('mapRelation', () => {
  it('picks the far side of the relation relative to the current work package', () => {
    const relationHal = {
      _type: 'Relation',
      id: 99,
      type: 'blocks',
      description: 'blocks deploy',
      _links: {
        from: { href: '/api/v3/work_packages/42', title: 'This one' },
        to: { href: '/api/v3/work_packages/50', title: 'Other one' },
      },
    };
    expect(mapRelation(relationHal, 42)).toEqual({
      id: 99,
      type: 'blocks',
      targetId: 50,
      targetSubject: 'Other one',
      description: 'blocks deploy',
    });
  });
});

describe('mapAttachment', () => {
  it('absolutizes the download url', () => {
    const attHal = {
      _type: 'Attachment',
      id: 5,
      fileName: 'log.txt',
      fileSize: 128,
      contentType: 'text/plain',
      _links: { downloadLocation: { href: '/api/v3/attachments/5/content' } },
    };
    expect(mapAttachment(attHal, BASE)).toEqual({
      id: 5,
      fileName: 'log.txt',
      fileSize: 128,
      contentType: 'text/plain',
      downloadUrl: 'https://op.test/api/v3/attachments/5/content',
    });
  });
});
