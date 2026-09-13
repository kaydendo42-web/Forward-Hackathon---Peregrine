import { describe, expect, it } from 'vitest';
import { FAMILY_GROUPS, greeting, groupFor, seasonOf } from '../src/core/family';
import * as workflow from '../src/core/workflow';
import type { Baseline } from '../src/core/types';
import { baseline } from './fixtures';

const trust: Baseline = {
  workbookId: 'FY25-taylor-family-trust', entityId: 'taylor-family-trust', entityName: 'Taylor Family Trust', entityType: 'trust',
  financialYear: 2025, baselineVersion: 1, synthetic: true,
  lines: [{ id: 'TR-BANK', category: 'bank', label: 'Trust bank balance', component: 'closing_balance', amountCents: 10000000,
    currency: 'AUD', basis: 'closing_balance', sourceRef: 'FY25-BANK', requestText: 'Provide the 30 June trust bank statement.', recurrence: 'annual' }],
};
const taylor = FAMILY_GROUPS[0];
const SPRING = new Date('2026-09-14T10:00:00+10:00');
function family() {
  let s = workflow.importBaseline(workflow.createWorkspace(), baseline);
  s = workflow.importBaseline(s, trust);
  s = workflow.startSeason(s, 'alex-taylor');
  return workflow.startSeason(s, 'taylor-family-trust');
}

describe('family group configuration', () => {
  it('maps every synthetic entity to the Taylor family with Alan as liaison', () => {
    expect(taylor).toMatchObject({ id: 'taylor-family', liaison: { firstName: 'Alan', email: 'taylorfamilyexample@gmail.com' } });
    for (const id of ['alex-taylor', 'sam-taylor', 'taylor-services', 'taylor-family-trust']) expect(groupFor(id)?.id).toBe('taylor-family');
    expect(groupFor('nobody')).toBeUndefined();
  });
  it('knows Australian seasons', () => {
    expect(seasonOf(new Date('2026-01-15'))).toBe('summer');
    expect(seasonOf(new Date('2026-04-15'))).toBe('autumn');
    expect(seasonOf(new Date('2026-07-15'))).toBe('winter');
    expect(seasonOf(SPRING)).toBe('spring');
    expect(seasonOf(new Date('2026-12-01'))).toBe('summer');
  });
  it('greets by first name with a season line and a gentler reminder', () => {
    expect(greeting('Alan', 'initial', SPRING)).toMatch(/^Hi Alan,/);
    expect(greeting('Alan', 'initial', SPRING)).toMatch(/spring/i);
    expect(greeting('Alan', 'initial', new Date('2026-07-01'))).toMatch(/warm/i);
    expect(greeting('Alan', 'reminder', SPRING)).toMatch(/nudge/i);
  });
});

describe('queueGroupOutreach', () => {
  it('drafts one email for the whole group, grouped by entity, addressed to the liaison', () => {
    const state = workflow.queueGroupOutreach(family(), taylor, 'initial', SPRING);
    const draft = state.outbox.at(-1)!;
    expect(draft).toMatchObject({ entityId: 'taylor-family', groupId: 'taylor-family', kind: 'initial', status: 'draft' });
    expect(draft.subject).toBe('FY2026 information request — Taylor family (2 entities)');
    expect(draft.body.startsWith('Hi Alan,')).toBe(true);
    expect(draft.body).toMatch(/spring/i);
    expect(draft.body.indexOf('Alex Taylor')).toBeLessThan(draft.body.indexOf('Taylor Family Trust'));
    expect(draft.body).toContain('1. FY2026: Provide the 30 June trust bank statement.');
    expect(draft.body).toMatch(/reply to this email with documents attached/i);
    expect(draft.body).toMatch(/SYNTHETIC DEMO/);
    expect(draft.requestIds.length).toBe(state.requests.length);
    expect(state.audit.at(-1)).toMatchObject({ action: 'outreach_drafted', entityId: 'taylor-family' });
  });
  it('does not duplicate an identical pending draft and supersedes it when a request changes', () => {
    const once = workflow.queueGroupOutreach(family(), taylor, 'initial', SPRING);
    expect(workflow.queueGroupOutreach(once, taylor, 'initial', SPRING)).toEqual(once);
    const changed = workflow.recordAnswer(once, 'alex-taylor:2026:ALE-DIV-CASH', 'Statement attached.');
    expect(changed.outbox.at(-1)!.status).toBe('superseded');
  });
  it('throws when nothing in the group needs outreach and skips entities with nothing outstanding', () => {
    expect(() => workflow.queueGroupOutreach(workflow.createWorkspace(), taylor, 'initial', SPRING)).toThrow(/No unanswered requests/);
    let s = family();
    for (const r of s.requests.filter(r => r.entityId === 'alex-taylor')) s = workflow.pauseRequest(s, r.id, true);
    const draft = workflow.queueGroupOutreach(s, taylor, 'reminder', SPRING).outbox.at(-1)!;
    expect(draft.body).not.toContain('Alex Taylor');
    expect(draft.subject).toContain('reminder');
    expect(draft.subject).toContain('(1 entity)');
  });
});

describe('startFamilySeason', () => {
  it('starts the season for every imported entity without requests, and only those', () => {
    let s = workflow.importBaseline(workflow.createWorkspace(), baseline);
    s = workflow.importBaseline(s, trust);
    s = workflow.startSeason(s, 'alex-taylor');
    const before = s.requests.length;
    const next = workflow.startFamilySeason(s, taylor.entityIds);
    expect(next.requests.filter(r => r.entityId === 'taylor-family-trust').length).toBe(2);
    expect(next.requests.filter(r => r.entityId === 'alex-taylor').length).toBe(before);
    expect(() => workflow.startFamilySeason(next, taylor.entityIds)).toThrow(/already/);
  });
});
