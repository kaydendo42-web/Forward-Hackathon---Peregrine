import { describe, expect, it } from 'vitest';
import * as workflow from '../src/core/workflow';
import type { Baseline, EvidenceInput } from '../src/core/types';

export const baseline: Baseline = {
  workbookId: 'FY25-alex-taylor', entityId: 'alex-taylor', entityName: 'Alex Taylor',
  entityType: 'individual', financialYear: 2025, baselineVersion: 1, synthetic: true,
  lines: [{ id: 'ALE-DIV-CASH', category: 'dividends', label: 'Cash dividends', component: 'cash',
    amountCents: 480000, currency: 'AUD', basis: 'cash', sourceRef: 'FY25-DIV',
    requestText: 'Please provide current-year dividend statements.', recurrence: 'annual' }],
};

export const evidence: EvidenceInput = {
  documentId: 'FY26-DIV-A', lineId: 'ALE-DIV-CASH', entityId: 'alex-taylor', financialYear: 2026,
  component: 'cash', currency: 'AUD', basis: 'cash', amountCents: 420000,
  description: 'Synthetic issuer statement A', filename: 'dividend-a.csv', fileHash: 'hash-a',
};

function active() {
  return workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
}
const reqId = 'alex-taylor:2026:ALE-DIV-CASH';

describe('season requests', () => {
  it('has an implemented state factory', () => expect(typeof workflow.createWorkspace).toBe('function'));
  it('retains the comparative but never treats FY25 income as FY26 evidence', () => {
    const req = active().requests.find(r => r.id === reqId)!;
    expect(req.priorAmountCents).toBe(480000);
    expect(req.comparisonCents).toBeNull();
    expect(workflow.reconcile(req).evidenceCents).toBeNull();
  });
  it('asks what changed independently of prior income', () => {
    expect(active().requests.some(r => r.category === 'current_year_changes')).toBe(true);
  });
  it('does not duplicate a season or overwrite an already imported baseline', () => {
    const state = active();
    expect(workflow.startSeason(state, 'alex-taylor')).toEqual(state);
    expect(() => workflow.importBaseline(state, baseline)).toThrow(/already imported/i);
  });
  it('adds an approved planning question with a reason and empty current amount', () => {
    const state = workflow.addPlanningRequest(active(), 'alex-taylor', 'Investment disposal', 'Approved planning note: obtain contract and cost base records');
    expect(state.requests.at(-1)?.origin).toBe('planning');
    expect(state.requests.at(-1)?.comparisonCents).toBeNull();
    expect(state.requests.at(-1)?.reason).toContain('Approved planning note');
  });
});

describe('evidence reconciliation', () => {
  it('does not add two closing-balance documents for the same account', () => {
    const pack: Baseline = { ...baseline, lines: [{ ...baseline.lines[0], id: 'BANK', component: 'closing_balance', basis: 'closing_balance' }] };
    let state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), pack), 'alex-taylor');
    const row = { ...evidence, lineId: 'BANK', component: 'closing_balance', basis: 'closing_balance' };
    state = workflow.receiveEvidence(state, 'alex-taylor:2026:BANK', row);
    expect(() => workflow.receiveEvidence(state, 'alex-taylor:2026:BANK', { ...row, documentId: 'SECOND' })).toThrow(/closing.balance/i);
  });
  it('shows a $1,000 shortfall then closes the difference with a second source', () => {
    let state = workflow.setComparison(active(), reqId, 520000);
    state = workflow.receiveEvidence(state, reqId, evidence);
    expect(workflow.reconcile(state.requests[0]).differenceCents).toBe(100000);
    state = workflow.receiveEvidence(state, reqId, { ...evidence, documentId: 'FY26-DIV-B', amountCents: 100000, fileHash: 'hash-b' });
    expect(workflow.reconcile(state.requests[0]).differenceCents).toBe(0);
    expect(state.requests[0].review).toBe('pending');
  });
  it('does not count a reuploaded source twice even when renamed or rehashed', () => {
    const state = workflow.receiveEvidence(active(), reqId, evidence);
    expect(workflow.receiveEvidence(state, reqId, { ...evidence, filename: 'renamed.csv', fileHash: 'changed' })).toEqual(state);
  });
  it('flags a changed amount under an existing document ID instead of ignoring it', () => {
    const state = workflow.receiveEvidence(active(), reqId, evidence);
    expect(() => workflow.receiveEvidence(state, reqId, { ...evidence, amountCents: 1 })).toThrow(/conflicting/i);
  });
  it.each([
    ['financialYear', 2025], ['entityId', 'sam-taylor'], ['component', 'franking_credit'],
    ['currency', 'USD'], ['basis', 'gross'], ['lineId', 'SAM-INT'],
  ])('rejects a mismatched %s', (key, value) => {
    expect(() => workflow.receiveEvidence(active(), reqId, { ...evidence, [key]: value })).toThrow(/mismatch/i);
  });
  it('keeps unknown support unknown and permits a genuine zero', () => {
    expect(workflow.reconcile(active().requests[0]).evidenceCents).toBeNull();
    const state = workflow.receiveEvidence(active(), reqId, { ...evidence, amountCents: 0 });
    expect(workflow.reconcile(state.requests[0]).evidenceCents).toBe(0);
  });
  it('rejects unsafe or fractional cents', () => {
    expect(() => workflow.setComparison(active(), reqId, 1.5)).toThrow(/amount/i);
    expect(() => workflow.receiveEvidence(active(), reqId, { ...evidence, amountCents: Number.NaN })).toThrow(/amount/i);
  });
});

describe('review gates and follow-up', () => {
  it('cannot accept a request with no support or an unresolved amount difference', () => {
    expect(() => workflow.reviewRequest(active(), reqId, 'accepted', 'Checked')).toThrow(/support/i);
    let state = workflow.setComparison(active(), reqId, 520000);
    state = workflow.receiveEvidence(state, reqId, evidence);
    expect(() => workflow.reviewRequest(state, reqId, 'accepted', 'Checked')).toThrow(/difference/i);
  });
  it('requires a review note and records a separate review event', () => {
    let state = workflow.receiveEvidence(active(), reqId, evidence);
    expect(() => workflow.reviewRequest(state, reqId, 'accepted', '')).toThrow(/note/i);
    state = workflow.reviewRequest(state, reqId, 'accepted', 'Reviewed the source; no independent comparison held.');
    expect(state.requests[0].review).toBe('accepted');
    expect(state.audit.at(-1)?.action).toBe('reviewed');
  });
  it('invalidates approval after changing evidence or a comparison', () => {
    let state = workflow.receiveEvidence(active(), reqId, evidence);
    state = workflow.reviewRequest(state, reqId, 'accepted', 'Checked');
    state = workflow.setComparison(state, reqId, 520000);
    expect(state.requests[0].review).toBe('pending');
  });
  it('records a not-applicable reason without inventing an amount', () => {
    const state = workflow.reviewRequest(active(), reqId, 'not_applicable', 'Investment sold before FY26; cessation checked.');
    expect(state.requests[0].review).toBe('not_applicable');
    expect(state.requests[0].comparisonCents).toBeNull();
  });
  it('produces draft-only outreach and is idempotent on repeated queueing', () => {
    const state = workflow.queueOutreach(active(), 'alex-taylor', 'initial');
    expect(state.outbox[0].status).toBe('draft');
    expect(state.outbox[0].body).toContain('2026');
    expect(workflow.queueOutreach(state, 'alex-taylor', 'initial')).toEqual(state);
  });
  it('suppresses obsolete follow-ups after a client responds', () => {
    let state = workflow.recordAnswer(active(), reqId, 'The statement arrives next week.');
    state = workflow.queueOutreach(state, 'alex-taylor', 'reminder');
    expect(state.outbox[0].requestIds).not.toContain(reqId);
  });
  it('pauses a request and cancels queued drafts containing it', () => {
    let state = workflow.queueOutreach(active(), 'alex-taylor', 'reminder');
    state = workflow.pauseRequest(state, reqId, true);
    expect(state.outbox[0].status).toBe('superseded');
    expect(workflow.queueOutreach(state, 'alex-taylor', 'reminder').outbox.at(-1)?.requestIds).not.toContain(reqId);
  });
  it('rejects stale or mixed review changes atomically', () => {
    const state = active();
    expect(() => workflow.applyReviewChanges(state, state.version - 1, [])).toThrow(/stale/i);
    expect(() => workflow.applyReviewChanges(state, state.version, [{ requestId: reqId, decision: 'accepted', note: 'Unchecked' }])).toThrow(/support/i);
    expect(state.requests[0].review).toBe('pending');
  });
});
